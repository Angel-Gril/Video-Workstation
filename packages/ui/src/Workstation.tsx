import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyCommand,
  batchCommand,
  deserializeProject,
  invertCommand,
  projectDuration,
  serializeProject,
  timelineToExportPlan,
  validateProject,
  sampleKeyframeTrack,
  type Command,
  type CommandHistoryEntry,
  type EffectKind,
  type MediaAsset,
  type Project,
  type ProjectMeta,
  type TimelineClip,
  type Track,
  type TrackKind,
  type TransitionKind
} from '@aivideo/core'
import {
  createNarrativePlan,
  createSegmentPlan,
  type NarrativePlan,
  type PlanStrategy,
  type SceneBoundary,
  type SpeechSegment,
  type VisualSignal
} from '@aivideo/ai'

type PlannerGoal = 'summary' | 'highlights' | 'tutorial'
type ExportQuality = 'fast' | 'balanced' | 'quality'
type MetadataFormat = 'fcpxml' | 'jianying'
type ClipDragMode = 'move' | 'trim-start' | 'trim-end'

interface Thumbnail {
  time: number
  dataUrl: string
}

const effectLabels: Record<EffectKind, string> = {
  opacity: '透明度',
  scale: '缩放',
  position: '位移',
  rotation: '旋转',
  brightness: '亮度',
  contrast: '对比度',
  saturation: '饱和度'
}

const effectRanges: Record<EffectKind, { min: number; max: number; step: number; fallback: number }> = {
  opacity: { min: 0, max: 1, step: .01, fallback: 1 },
  scale: { min: .1, max: 4, step: .01, fallback: 1 },
  position: { min: -1200, max: 1200, step: 1, fallback: 0 },
  rotation: { min: -360, max: 360, step: 1, fallback: 0 },
  brightness: { min: 0, max: 3, step: .01, fallback: 1 },
  contrast: { min: 0, max: 3, step: .01, fallback: 1 },
  saturation: { min: 0, max: 3, step: .01, fallback: 1 }
}

const transitionLabels: Record<Exclude<TransitionKind, 'none'>, string> = {
  fade: '淡入淡出',
  dissolve: '叠化',
  'wipe-left': '左向擦除',
  'wipe-right': '右向擦除',
  'slide-left': '左向滑动',
  'slide-right': '右向滑动'
}

function transitionLabel(kind: 'cut' | 'none' | TransitionKind): string {
  return kind === 'cut' || kind === 'none' || kind === undefined ? '硬切' : transitionLabels[kind]
}

interface ClipDragState {
  clipId: string
  trackId: string
  mode: ClipDragMode
  pointerId: number
  originX: number
  timelineStart: number
  sourceStart: number
  duration: number
}

interface ClipDragPreview {
  clipId: string
  timelineStart: number
  sourceStart: number
  duration: number
}

interface MultiDragState {
  pointerId: number
  originX: number
  anchorId: string
  clipIds: string[]
  startPositions: Array<{
    clipId: string
    trackId: string
    timelineStart: number
  }>
}

interface MarqueeState {
  pointerId: number
  originX: number
  originY: number
  currentX: number
  currentY: number
}

interface PreviewSource {
  mode: 'media' | 'timeline'
  mediaId: string | null
}

const trackDefaults: Array<Omit<Track, 'clips' | 'id'>> = [
  { kind: 'video', locked: false, muted: false, hidden: false },
  { kind: 'audio', locked: false, muted: false, hidden: false },
  { kind: 'caption', locked: false, muted: false, hidden: false }
]

const narrationVoices = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 自然' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 年轻' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 专业' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '小北 · 东北' }
]

const narrationRates = [
  { id: '-10%', label: '慢速' },
  { id: '+0%', label: '标准' },
  { id: '+15%', label: '轻快' },
  { id: '+30%', label: '快速' }
]

function makeInitialProject(): Project {
  return {
    meta: {
      version: 1,
      name: '未命名项目',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      width: 1920,
      height: 1080,
      frameRate: 30
    },
    narrationSettings: {
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      audioDucking: { enabled: true, gain: .3, attack: .16, release: .45 }
    },
    media: [],
    timeline: {
      duration: 0,
      tracks: trackDefaults.map((track) => ({
        ...track,
        id: `track-${track.kind}`,
        clips: []
      }))
    }
  }
}

function withDefaultTracks(project: Project): Project {
  const existing = new Set(project.timeline.tracks.map((track) => track.kind))
  const missing = trackDefaults
    .filter((track) => !existing.has(track.kind))
    .map((track, index) => ({
      ...track,
      id: `track-${track.kind}-${Date.now()}-${index}`,
      clips: []
    }))
  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: [...project.timeline.tracks, ...missing]
    }
  }
}

function normalizeTransforms(project: Project): Project {
  const normalized: Project = {
    ...project,
    narrationSettings: {
      ...makeInitialProject().narrationSettings,
      ...project.narrationSettings,
      audioDucking: {
        ...makeInitialProject().narrationSettings?.audioDucking,
        ...project.narrationSettings?.audioDucking
      }
    },
    timeline: {
      ...project.timeline,
      tracks: project.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
          ...clip,
          transform: { ...defaultTransform(), ...clip.transform },
          effects: Array.isArray(clip.effects) ? clip.effects : []
        }))
      }))
    }
  }
  return normalized
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function defaultTransform() {
  return { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, brightness: 1, contrast: 1, saturation: 1 }
}

function effectBaseValue(transform: Project['timeline']['tracks'][number]['clips'][number]['transform'], effect: EffectKind): number {
  if (effect === 'opacity') return transform.opacity
  if (effect === 'scale') return transform.scale
  if (effect === 'position') return transform.x
  if (effect === 'rotation') return transform.rotation
  return transform[effect]
}

function trackIcon(kind: TrackKind): string {
  if (kind === 'video') return 'V'
  if (kind === 'audio') return 'A'
  if (kind === 'music') return 'M'
  return 'T'
}

function formatTime(value: number): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0)
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`
}

const exportQualityMap: Record<ExportQuality, { crf: number; preset: string; label: string }> = {
  fast: { crf: 26, preset: 'veryfast', label: '快速' },
  balanced: { crf: 21, preset: 'medium', label: '均衡' },
  quality: { crf: 17, preset: 'slow', label: '高画质' }
}

export function Workstation() {
  const [project, setProjectState] = useState<Project>(makeInitialProject)
  const [history, setHistory] = useState<CommandHistoryEntry[]>([])
  const [future, setFuture] = useState<Command[]>([])
  const [plan, setPlan] = useState<NarrativePlan | null>(null)
  const [planStrategy, setPlanStrategy] = useState<PlanStrategy['id']>('balanced')
  const [planGoal, setPlanGoal] = useState<PlannerGoal>('summary')
  const [reviewedSegmentIds, setReviewedSegmentIds] = useState<Set<string>>(new Set())
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [assetPath, setAssetPath] = useState('')
  const [instruction, setInstruction] = useState('')
  const [targetSeconds, setTargetSeconds] = useState(30)
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null)
  const [importing, setImporting] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisLabel, setAnalysisLabel] = useState('')
  const [speechSegments, setSpeechSegments] = useState<SpeechSegment[]>([])
  const [sceneBoundaries, setSceneBoundaries] = useState<SceneBoundary[]>([])
  const [visualSignals, setVisualSignals] = useState<VisualSignal[]>([])
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({})
  const [thumbnails, setThumbnails] = useState<Record<string, Thumbnail[]>>({})
  const [generatingNarration, setGeneratingNarration] = useState(false)
  const [narrationText, setNarrationText] = useState('')
  const [narrationVoice, setNarrationVoice] = useState(narrationVoices[0]!.id)
  const [narrationRate, setNarrationRate] = useState(narrationRates[1]!.id)
  const [narrationDucking, setNarrationDucking] = useState(true)
  const [previewSource, setPreviewSource] = useState<PreviewSource>({ mode: 'media', mediaId: null })
  const [previewTime, setPreviewTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const previewRef = useRef<HTMLVideoElement | null>(null)
  const timelineCanvasRef = useRef<HTMLDivElement | null>(null)
  const sceneCacheRef = useRef(new Map<string, SceneBoundary[]>())
  const speechCacheRef = useRef(new Map<string, SpeechSegment[]>())
  const waveformCacheRef = useRef(new Map<string, number[]>())
  const thumbnailCacheRef = useRef(new Map<string, Thumbnail[]>())
  const visualCacheRef = useRef(new Map<string, VisualSignal[]>())
  const [clipDrag, setClipDrag] = useState<ClipDragState | null>(null)
  const [clipDragPreview, setClipDragPreview] = useState<ClipDragPreview | null>(null)
  const [multiDrag, setMultiDrag] = useState<MultiDragState | null>(null)
  const [multiDragDelta, setMultiDragDelta] = useState(0)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set())
  const selectedClipIdsRef = useRef(selectedClipIds)
  const [snapping, setSnapping] = useState(true)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [zoom, setZoom] = useState(42)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const [exportQuality, setExportQuality] = useState<ExportQuality>('balanced')
  const [exportName, setExportName] = useState('exports/输出.mp4')
  const [selectedEffect, setSelectedEffect] = useState<EffectKind>('opacity')
  const [message, setMessage] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const projectFileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    selectedClipIdsRef.current = selectedClipIds
  }, [selectedClipIds])

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => setServiceOnline(Boolean(data.ok && data.ffmpeg && data.ffprobe)))
      .catch(() => setServiceOnline(false))

    fetch('/api/project')
      .then((response) => response.json())
      .then((data) => {
        if (!data.project) return
        const saved = deserializeProject(JSON.stringify({
          ...data,
          format: 'ai-video-workstation/1'
        }))
        const restored = normalizeTransforms(withDefaultTracks(saved.project))
        setProjectState(restored)
        setNarrationVoice(restored.narrationSettings?.voice ?? narrationVoices[0]!.id)
        setNarrationRate(restored.narrationSettings?.rate ?? narrationRates[1]!.id)
        setNarrationDucking(restored.narrationSettings?.audioDucking?.enabled ?? true)
        setHistory(saved.history)
        setFuture(saved.future)
        setPreviewSource({ mode: 'media', mediaId: restored.media[0]?.id ?? null })
        setSelectedAssetId(restored.media[0]?.id ?? null)
        for (const asset of restored.media) {
          if (asset.kind === 'video') {
            void loadThumbnails(asset).catch(() => undefined)
          }
          if (asset.kind === 'video' || asset.kind === 'audio') {
            void loadWaveform(asset).catch(() => undefined)
          }
        }
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => {
      const documentText = serializeProject(project, { history, future })
      fetch('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: documentText
      }).then(() => setDirty(false)).catch(() => undefined)
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [dirty, project, history, future])

  function dispatch(command: Command, nextProject: Project) {
    const inverse = invertCommand(command, project)
    setHistory((items) => [
      ...items,
      { id: command.id, command, inverse, at: new Date().toISOString() }
    ])
    setFuture([])
    setProjectState(updateMetaTime(nextProject))
    setDirty(true)
  }

  function updateMetaTime(value: Project): Project {
    return { ...value, meta: { ...value.meta, updatedAt: new Date().toISOString() } }
  }

  function updateProjectMeta(patch: Partial<ProjectMeta>, label: string) {
    const next = updateMetaTime({ ...project, meta: { ...project.meta, ...patch } })
    dispatch({
      id: uid('cmd-meta'),
      kind: 'project.set',
      payload: { project: next }
    }, next)
    setMessage(label)
  }

  function updateNarrationSettings(patch: Project['narrationSettings'], label: string) {
    const next = updateMetaTime({
      ...project,
      narrationSettings: {
        ...project.narrationSettings,
        ...patch
      }
    })
    dispatch({
      id: uid('cmd-narration'),
      kind: 'project.set',
      payload: { project: next }
    }, next)
    setMessage(label)
  }

  function renameProject(name: string) {
    setProjectState((current) => updateMetaTime(normalizeTransforms({
      ...current,
      meta: { ...current.meta, name }
    })))
    setDirty(true)
  }

  const duration = useMemo(() => projectDuration(project), [project])
  const timelineSpan = Math.max(8, duration + 2)
  const allTimelineClips = useMemo(
    () => project.timeline.tracks.flatMap((track) => track.clips),
    [project.timeline.tracks]
  )
  const snapPoints = useMemo(() => {
    const points = new Set<number>([0])
    for (const clip of allTimelineClips) {
      points.add(clip.timelineStart)
      points.add(clip.timelineStart + clip.duration)
    }
    points.add(duration)
    return [...points].filter((value) => Number.isFinite(value) && value >= 0)
  }, [allTimelineClips, duration])

  function snapTime(time: number, ignoreClipIds: string[] = []) {
    if (!snapping || zoom < 16) return Math.max(0, time)
    const ignored = new Set(ignoreClipIds)
    const targets = [
      ...snapPoints,
      previewTime
    ].filter((point) => !allTimelineClips.some((clip) =>
      ignored.has(clip.id) &&
      (Math.abs(point - clip.timelineStart) < .001 ||
        Math.abs(point - clip.timelineStart - clip.duration) < .001)
    ))
    const threshold = Math.max(6 / zoom, .035)
    const snapped = targets.find((point) => Math.abs(point - time) <= threshold)
    return Math.max(0, snapped ?? time)
  }

  const selectedClip = useMemo(() => {
    for (const track of project.timeline.tracks) {
      const clip = track.clips.find((item) => item.id === selectedClipId)
      if (clip) return clip
    }
    return null
  }, [project, selectedClipId])

  const selectedAsset = useMemo(
    () => project.media.find((asset) => asset.id === selectedAssetId) ?? null,
    [project.media, selectedAssetId]
  )
  const previewAsset = useMemo(
    () => project.media.find((asset) => asset.id === previewSource.mediaId) ?? null,
    [project.media, previewSource]
  )
  const activeTimelineClip = useMemo(() => {
    if (previewSource.mode !== 'timeline' || !previewAsset) return null
    return project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.mediaId === previewAsset.id &&
        previewTime >= clip.timelineStart &&
        previewTime < clip.timelineStart + clip.duration) ?? null
  }, [previewAsset, previewSource, previewTime, project.timeline.tracks])

  const sourcePreviewTime = useMemo(() => {
    if (!previewAsset) return 0
    if (previewSource.mode === 'timeline' && activeTimelineClip) {
      return clamp(
        previewTime - activeTimelineClip.timelineStart + activeTimelineClip.sourceStart,
        0,
        previewAsset.duration
      )
    }
    return clamp(previewTime, 0, previewAsset.duration)
  }, [activeTimelineClip, previewAsset, previewSource.mode, previewTime])

  const activeCaption = useMemo(() => {
    if (previewSource.mode !== 'timeline') return null
    for (const track of project.timeline.tracks) {
      if (track.kind !== 'caption' || track.hidden) continue
      const clip = track.clips.find((item) =>
        previewTime >= item.timelineStart &&
        previewTime < item.timelineStart + item.duration
      )
      if (clip?.text) return clip.text
    }
    return null
  }, [previewSource.mode, previewTime, project.timeline.tracks])

  const activeNarration = useMemo(() => {
    if (previewSource.mode !== 'timeline') return ''
    for (const track of project.timeline.tracks) {
      if (track.kind !== 'audio' || track.hidden) continue
      for (const clip of track.clips) {
        if (clip.narration && previewTime >= clip.timelineStart && previewTime < clip.timelineStart + clip.duration) {
          return clip.narration
        }
      }
    }
    return ''
  }, [previewSource.mode, previewTime, project.timeline.tracks])

  const activePreviewStyle = useMemo(() => {
    if (!activeTimelineClip) return { transform: undefined, opacity: undefined, filter: undefined }
    const localTime = previewTime - activeTimelineClip.timelineStart
    const sampled = new Map<EffectKind, number>()
    for (const track of activeTimelineClip.effects) {
      const value = sampleKeyframeTrack(track, localTime)
      if (value !== null) sampled.set(track.property, value)
    }
    const transform = activeTimelineClip.transform
    const scale = sampled.get('scale') ?? transform.scale
    const position = sampled.get('position') ?? transform.x
    const rotation = sampled.get('rotation') ?? transform.rotation
    const opacity = sampled.get('opacity') ?? transform.opacity
    const filters: string[] = []
    const brightness = sampled.get('brightness')
    if (brightness !== undefined) filters.push(`brightness(${brightness})`)
    const contrast = sampled.get('contrast')
    if (contrast !== undefined) filters.push(`contrast(${contrast})`)
    const saturation = sampled.get('saturation')
    if (saturation !== undefined) filters.push(`saturate(${saturation})`)
    return {
      transform: `translate(${position}px, ${transform.y}px) rotate(${rotation}deg) scale(${scale})`,
      opacity: clamp(opacity, 0, 1),
      filter: filters.length > 0 ? filters.join(' ') : undefined
    }
  }, [activeTimelineClip, previewTime])

  const speechByAsset = useMemo(() => {
    const result = new Map<string, SpeechSegment[]>()
    for (const segment of speechSegments) {
      result.set(segment.mediaId, [...result.get(segment.mediaId) ?? [], segment])
    }
    return result
  }, [speechSegments])

  const scenesByAsset = useMemo(() => {
    const result = new Map<string, SceneBoundary[]>()
    for (const scene of sceneBoundaries) {
      result.set(scene.mediaId, [...result.get(scene.mediaId) ?? [], scene])
    }
    return result
  }, [sceneBoundaries])

  const visualByAsset = useMemo(() => {
    const result = new Map<string, VisualSignal[]>()
    for (const signal of visualSignals) {
      result.set(signal.mediaId, [...result.get(signal.mediaId) ?? [], signal])
    }
    return result
  }, [visualSignals])

  useEffect(() => {
    const video = previewRef.current
    if (!video || !previewAsset) return
    if (Number.isFinite(video.duration) && Math.abs(video.currentTime - sourcePreviewTime) > 0.05) {
      video.currentTime = sourcePreviewTime
    }
  }, [previewAsset?.id, previewSource.mode, sourcePreviewTime])

  function firstTrack(kind: TrackKind): Track | null {
    return project.timeline.tracks.find((track) => track.kind === kind && !track.locked) ??
      project.timeline.tracks.find((track) => track.kind === kind) ?? null
  }

  function makeClip(
    asset: MediaAsset,
    trackId: string,
    timelineStart: number,
    sourceStart = 0,
    clipDuration = asset.duration
  ): TimelineClip {
    return {
      id: uid('clip'),
      trackId,
      mediaId: asset.id,
      sourceStart,
      timelineStart,
      duration: clamp(clipDuration, 0.05, asset.duration - sourceStart),
      transform: defaultTransform(),
      effects: [],
      volume: 1,
      transitionIn: 'none',
      transitionOut: 'none'
    }
  }

  async function loadWaveform(asset: MediaAsset) {
    const cached = waveformCacheRef.current.get(asset.path)
    if (cached) {
      setWaveforms((items) => ({ ...items, [asset.id]: cached }))
      return
    }
    const response = await fetch(`/api/analyze/waveform?path=${encodeURIComponent(asset.path)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? '波形分析失败')
    waveformCacheRef.current.set(asset.path, data.waveform)
    setWaveforms((items) => ({ ...items, [asset.id]: data.waveform }))
  }

  async function loadThumbnails(asset: MediaAsset) {
    const cached = thumbnailCacheRef.current.get(asset.path)
    if (cached) {
      setThumbnails((items) => ({ ...items, [asset.id]: cached }))
      return
    }
    const response = await fetch(`/api/media/thumbnails?path=${encodeURIComponent(asset.path)}&count=10&width=160`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? '缩略图提取失败')
    thumbnailCacheRef.current.set(asset.path, data.thumbnails)
    setThumbnails((items) => ({ ...items, [asset.id]: data.thumbnails }))
  }

  async function loadVisualSignals(asset: MediaAsset) {
    const cached = visualCacheRef.current.get(asset.path)
    if (cached) {
      setVisualSignals((items) => [...items.filter((item) => item.mediaId !== asset.id), ...cached])
      return
    }
    const samples = Math.max(8, Math.min(24, Math.round(asset.duration / 30)))
    const response = await fetch(`/api/analyze/visual?path=${encodeURIComponent(asset.path)}&samples=${samples}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? '视觉信号分析失败')
    const normalized = data.signals.map((signal: VisualSignal) => ({ ...signal, mediaId: asset.id }))
    visualCacheRef.current.set(asset.path, normalized)
    setVisualSignals((items) => [...items.filter((item) => item.mediaId !== asset.id), ...normalized])
  }

  async function addAssetFromPath(path: string) {
    if (!path.trim()) {
      setMessage('请输入素材路径')
      return
    }
    try {
      setImporting(true)
      setMessage('正在读取素材...')
      const response = await fetch('/api/media/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path.trim() })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '素材读取失败')
      const asset: MediaAsset = { ...data, id: uid('media') }
      const track = firstTrack(asset.kind === 'audio' ? 'audio' : 'video')
      if (!track) throw new Error('没有可用的目标轨道')
      const clip = makeClip(asset, track.id, duration)
      const commands: Command[] = [
        { id: uid('cmd-media'), kind: 'media.add', payload: { asset } },
        { id: uid('cmd-clip'), kind: 'clip.add', payload: { clip } }
      ]
      const next = commands.reduce(applyCommand, project)
      dispatch(batchCommand(project, commands, `导入 ${asset.name}`), updateMetaTime(next))
      setAssetPath('')
      setSelectedAssetId(asset.id)
      setPreviewSource({ mode: 'media', mediaId: asset.id })
      setPreviewTime(0)
      setMessage(`${asset.name} 已导入并加入时间线`)
      void (asset.kind === 'video' ? loadThumbnails(asset) : loadWaveform(asset)).catch(() => undefined)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入素材失败')
    } finally {
      setImporting(false)
    }
  }

  function addAssetToTimeline(asset: MediaAsset) {
    const track = firstTrack(asset.kind === 'audio' ? 'audio' : 'video')
    if (!track) {
      setMessage(`没有可用的${asset.kind}轨道`)
      return
    }
    try {
      const clip = makeClip(asset, track.id, duration)
      const command: Command = { id: uid('cmd-clip'), kind: 'clip.add', payload: { clip } }
      dispatch(command, updateMetaTime(applyCommand(project, command)))
      setSelectedAssetId(asset.id)
      setPreviewSource({ mode: 'media', mediaId: asset.id })
      setPreviewTime(0)
      setMessage('素材已加入时间线')
      void (asset.kind === 'video' ? loadThumbnails(asset) : loadWaveform(asset)).catch(() => undefined)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加入时间线失败')
    }
  }

  function addSceneToTimeline(asset: MediaAsset, scene: SceneBoundary) {
    const track = firstTrack('video')
    if (!track) return
    try {
      const clip = makeClip(asset, track.id, duration, scene.start, scene.end - scene.start)
      const command: Command = { id: uid('cmd-scene'), kind: 'clip.add', payload: { clip } }
      dispatch(command, updateMetaTime(applyCommand(project, command)))
      setMessage('场景已加入时间线')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加入场景失败')
    }
  }

  function removeAsset(asset: MediaAsset) {
    const usedClips = project.timeline.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.mediaId === asset.id)
    const commands: Command[] = usedClips.map((clip) => ({
      id: uid('cmd-remove'),
      kind: 'clip.remove',
      payload: { clipId: clip.id }
    }))
    commands.push({
      id: uid('cmd-media'),
      kind: 'media.remove',
      payload: { mediaId: asset.id }
    })
    try {
      const next = commands.reduce(applyCommand, project)
      dispatch(batchCommand(project, commands, `移除素材 ${asset.name}`), updateMetaTime(next))
      setSpeechSegments((items) => items.filter((item) => item.mediaId !== asset.id))
      setSceneBoundaries((items) => items.filter((item) => item.mediaId !== asset.id))
      setVisualSignals((items) => items.filter((item) => item.mediaId !== asset.id))
      speechCacheRef.current.delete(asset.path)
      sceneCacheRef.current.delete(asset.path)
      if (previewSource.mediaId === asset.id) {
        const nextAsset = project.media.find((item) => item.id !== asset.id) ?? null
        setPreviewSource({ mode: 'media', mediaId: nextAsset?.id ?? null })
      }
      if (selectedAssetId === asset.id) setSelectedAssetId(null)
      if (selectedClip && usedClips.some((clip) => clip.id === selectedClip.id)) setSelectedClipId(null)
      waveformCacheRef.current.delete(asset.path)
      thumbnailCacheRef.current.delete(asset.path)
      visualCacheRef.current.delete(asset.path)
      setMessage('素材已移除')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '移除素材失败')
    }
  }

  async function analyzeVisual(asset: MediaAsset) {
    if (asset.kind !== 'video') return
    await loadVisualSignals(asset)
  }

  async function generateNarration() {
    const text = narrationText.trim()
    if (!text) {
      setMessage('请输入解说文本')
      return
    }
    const track = firstTrack('audio')
    if (!track) {
      setMessage('没有可用音频轨')
      return
    }
    try {
      setGeneratingNarration(true)
      setMessage('正在生成解说语音...')
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: narrationVoice, rate: narrationRate })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '语音合成失败')
      const asset: MediaAsset = { ...data, id: uid('media') }
      const clip: TimelineClip = {
        ...makeClip(asset, track.id, duration),
        narration: text,
        narrationVoice,
        narrationRate
      }
      const commands: Command[] = [
        { id: uid('cmd-media'), kind: 'media.add', payload: { asset } },
        { id: uid('cmd-clip'), kind: 'clip.add', payload: { clip } }
      ]
      const next = commands.reduce(applyCommand, project)
      dispatch(batchCommand(project, commands, '生成解说语音'), updateMetaTime(next))
      setNarrationText('')
      setSpeechSegments((items) => [...items, {
        id: uid('speech'),
        mediaId: asset.id,
        start: 0,
        end: asset.duration,
        text,
        language: 'zh-CN'
      }])
      void loadWaveform(asset).catch(() => undefined)
      setMessage('解说语音已加入时间线')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '语音合成失败')
    } finally {
      setGeneratingNarration(false)
    }
  }

  async function analyzeAsset(asset: MediaAsset, mode: 'speech' | 'scenes' | 'all') {
    const tasks: Array<Promise<void>> = []
    const wantSpeech = mode === 'speech' || mode === 'all'
    const wantScenes = asset.kind === 'video' && (mode === 'scenes' || mode === 'all')
    if (wantSpeech) {
      tasks.push((async () => {
        const cached = speechCacheRef.current.get(asset.path)
        if (cached) {
          setSpeechSegments((items) => [
            ...items.filter((item) => item.mediaId !== asset.id),
            ...cached.map((segment) => ({ ...segment, mediaId: asset.id }))
          ])
          return
        }
        const response = await fetch(`/api/analyze/speech?path=${encodeURIComponent(asset.path)}&assetId=${encodeURIComponent(asset.id)}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? '语音识别失败')
        const segments: SpeechSegment[] = data.segments
        const normalized = segments.map((segment) => ({ ...segment, mediaId: asset.id }))
        speechCacheRef.current.set(asset.path, normalized)
        setSpeechSegments((items) => [
          ...items.filter((item) => item.mediaId !== asset.id),
          ...normalized
        ])
      })())
    }
    if (wantScenes) {
      tasks.push((async () => {
        const cached = sceneCacheRef.current.get(asset.path)
        if (cached) {
          setSceneBoundaries((items) => [
            ...items.filter((item) => item.mediaId !== asset.id),
            ...cached.map((scene) => ({ ...scene, mediaId: asset.id }))
          ])
          return
        }
        const response = await fetch(`/api/analyze/scenes?path=${encodeURIComponent(asset.path)}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? '场景检测失败')
        const scenes: SceneBoundary[] = data.scenes
        const normalized = scenes.map((scene) => ({ ...scene, mediaId: asset.id }))
        sceneCacheRef.current.set(asset.path, normalized)
        setSceneBoundaries((items) => [
          ...items.filter((item) => item.mediaId !== asset.id),
          ...normalized
        ])
      })())
    }
    await Promise.all(tasks)
  }

  async function analyzeAllMedia() {
    const assets = project.media.filter((asset) => asset.kind === 'video' || asset.kind === 'audio')
    if (assets.length === 0) {
      setMessage('请先导入视频或音频素材')
      return
    }
    try {
      setAnalyzing(true)
      let speechCount = 0
      let sceneCount = 0
      for (const [index, asset] of assets.entries()) {
        setAnalysisLabel(`正在分析 ${asset.name}（${index + 1}/${assets.length}）`)
        await analyzeAsset(asset, asset.kind === 'video' ? 'all' : 'speech')
        await analyzeVisual(asset).catch(() => undefined)
        speechCount += (speechCacheRef.current.get(asset.path) ?? []).length
        sceneCount += (sceneCacheRef.current.get(asset.path) ?? []).length
      }
      setMessage(`分析完成：${speechCount} 段语音 / ${sceneCount} 个场景`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '素材分析失败')
    } finally {
      setAnalyzing(false)
      setAnalysisLabel('')
    }
  }

  async function generatePlan() {
    const assets = project.media.filter((asset) => asset.kind === 'video' || asset.kind === 'audio')
    if (assets.length === 0) {
      setMessage('请先导入素材')
      return
    }
    try {
      setAnalyzing(true)
      const transcript: SpeechSegment[] = []
      const scenes: SceneBoundary[] = []
      for (const [index, asset] of assets.entries()) {
        setAnalysisLabel(`正在分析 ${asset.name}（${index + 1}/${assets.length}）`)
        await analyzeAsset(asset, asset.kind === 'video' ? 'all' : 'speech')
        await analyzeVisual(asset).catch(() => undefined)
        transcript.push(...(speechCacheRef.current.get(asset.path) ?? []))
        scenes.push(...(sceneCacheRef.current.get(asset.path) ?? []))
      }
      const generated = createNarrativePlan({
        goal: planGoal,
        targetSeconds,
        transcript,
        scenes,
        visualSignals: visualSignals.length > 0 ? visualSignals : undefined,
        instruction: instruction.trim() || undefined
      }, { strategyId: planStrategy })
      setPlan(generated)
      setNarrationText(generated.segments.map((segment) => segment.narration).filter(Boolean).join('\n'))
      setReviewedSegmentIds(new Set())
      setMessage(generated.segments.length
        ? `已生成 ${generated.segments.length} 个候选：${scenes.length} 个场景 / ${transcript.length} 段语音`
        : '没有足够的候选片段，请检查素材或调整意图')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '方案生成失败')
    } finally {
      setAnalyzing(false)
      setAnalysisLabel('')
    }
  }

  function choosePlanStrategy(strategyId: PlanStrategy['id']) {
    if (!plan) return
    const regenerated = createNarrativePlan(plan.input, {
      videoTrackId: plan.options.videoTrackId ?? 'track-video',
      captionTrackId: plan.options.captionTrackId ?? 'track-caption',
      strategyId
    })
    setPlan(regenerated)
    setPlanStrategy(strategyId)
    setReviewedSegmentIds(new Set())
  }

  function toggleSegment(segmentId: string, accepted: boolean) {
    if (!plan) return
    const selectedIds = accepted
      ? Array.from(new Set([...plan.selectedIds, segmentId]))
      : plan.selectedIds.filter((id) => id !== segmentId)
    setPlan(createSegmentPlan(plan, selectedIds, plan.strategyId))
    setReviewedSegmentIds((items) => new Set(items).add(segmentId))
  }

  function acceptAllSegments() {
    if (!plan) return
    const all = plan.segments.map((segment) => segment.id)
    setPlan(createSegmentPlan(plan, all, plan.strategyId))
    setReviewedSegmentIds(new Set(all))
  }

  function generateDraftNarrations() {
    if (!plan || plan.selectedIds.length === 0) {
      setMessage('请先生成并采纳剪辑方案')
      return
    }
    const text = plan.segments
      .filter((segment) => plan.selectedIds.includes(segment.id))
      .map((segment) => segment.narration)
      .filter(Boolean)
      .join('\n')
    setNarrationText(text)
    setMessage('已根据方案生成解说草稿')
  }

  function clearPlan() {
    setPlan(null)
    setReviewedSegmentIds(new Set())
  }

  async function applyPlan() {
    if (!plan) return
    try {
      const plannedClips = plan.commands.flatMap((item) => {
        const clip = item.payload.clip as TimelineClip | undefined
        return clip ? [clip] : []
      })
      const pendingNarrations = plannedClips.filter((clip) => clip.narrationPending)
      const removals: Command[] = []
      for (const track of project.timeline.tracks) {
        for (const clip of track.clips) {
          const overlaps = plannedClips.some((planned) =>
            planned.trackId === track.id &&
            clip.timelineStart < planned.timelineStart + planned.duration &&
            clip.timelineStart + clip.duration > planned.timelineStart
          )
          if (overlaps) {
            removals.push({
              id: uid('cmd-plan-remove'),
              kind: 'clip.remove',
              payload: { clipId: clip.id }
            })
          }
        }
      }
      const commands = [...removals, ...plan.commands as Command[]]
      if (pendingNarrations.length > 0) {
        try {
          const narrationTrack = firstTrack('audio')
          if (!narrationTrack) throw new Error('没有可用解说轨')
          const narrationCommands: Command[] = []
          for (const draft of pendingNarrations) {
            const response = await fetch('/api/tts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: draft.narration,
                voice: draft.narrationVoice ?? narrationVoice,
                rate: draft.narrationRate ?? narrationRate
              })
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error ?? '语音合成失败')
            const asset: MediaAsset = { ...data, id: uid('media') }
            const clip: TimelineClip = {
              ...draft,
              id: uid('clip-narration'),
              trackId: narrationTrack.id,
              mediaId: asset.id,
              narrationPath: asset.path,
              narrationPending: false,
              volume: draft.volume || 1.15
            }
            narrationCommands.push(
              { id: uid('cmd-media'), kind: 'media.add', payload: { asset } },
              { id: uid('cmd-clip'), kind: 'clip.add', payload: { clip } }
            )
            void loadWaveform(asset).catch(() => undefined)
          }
          const executable = [...commands.filter((command) => command.kind !== 'clip.add' || !((command.payload.clip as TimelineClip | undefined)?.narrationPending)), ...narrationCommands]
          const next = executable.reduce(applyCommand, project)
          dispatch(batchCommand(project, executable, '应用 AI 剪辑方案并生成解说'), updateMetaTime(next))
          setSpeechSegments((items) => [
            ...items,
            ...narrationCommands
              .filter((command) => command.kind === 'media.add')
              .map((command) => command.payload.asset as MediaAsset)
              .map((asset, index) => ({
                id: uid('speech'),
                mediaId: asset.id,
                start: 0,
                end: asset.duration,
                text: pendingNarrations[index]?.narration ?? '',
                language: 'zh-CN'
              }))
          ])
        } catch (error) {
          setMessage(error instanceof Error ? error.message : '方案解说生成失败')
        }
      } else {
        const next = commands.reduce(applyCommand, project)
        dispatch(batchCommand(project, commands, '应用 AI 剪辑方案'), updateMetaTime(next))
      }
      const firstPlanned = plannedClips.find((clip) => !clip.narrationPending)
      if (firstPlanned) {
        setPreviewSource({ mode: 'timeline', mediaId: firstPlanned.mediaId })
        setPreviewTime(firstPlanned.timelineStart)
      }
      setMessage(`方案已应用：${plannedClips.length - pendingNarrations.length} 个视频片段 / ${pendingNarrations.length} 条解说`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '方案应用失败')
    }
  }

  function splitSelectedClip() {
    if (!selectedClip) return
    const at = selectedClip.timelineStart + selectedClip.duration / 2
    const command: Command = {
      id: uid('cmd-split'),
      kind: 'clip.split',
      payload: { clipId: selectedClip.id, at }
    }
    try {
      dispatch(command, updateMetaTime(applyCommand(project, command)))
      setMessage('片段已拆分')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '拆分失败')
    }
  }

  function splitSelectedClips() {
    const clips = allTimelineClips.filter((clip) => selectedClipIds.has(clip.id))
    if (clips.length === 0) return
    const commands: Command[] = []
    for (const clip of clips) {
      if (clip.duration < .1) continue
      commands.push({
        id: uid('cmd-split'),
        kind: 'clip.split',
        payload: { clipId: clip.id, at: clip.timelineStart + clip.duration / 2 }
      })
    }
    if (commands.length === 0) return
    const batch = batchCommand(project, commands, `拆分 ${commands.length} 个片段`)
    try {
      dispatch(batch, updateMetaTime(applyCommand(project, batch)))
      setMessage(`已拆分 ${commands.length} 个片段`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批量拆分失败')
    }
  }

  function removeSelectedClip() {
    if (!selectedClip) return
    const command: Command = {
      id: uid('cmd-remove'),
      kind: 'clip.remove',
      payload: { clipId: selectedClip.id }
    }
    dispatch(command, updateMetaTime(applyCommand(project, command)))
    setSelectedClipId(null)
  }

  function removeSelectedClips() {
    const clips = allTimelineClips.filter((clip) => selectedClipIds.has(clip.id))
    if (clips.length === 0) return
    const commands: Command[] = clips.map((clip) => ({
      id: uid('cmd-remove'),
      kind: 'clip.remove' as const,
      payload: { clipId: clip.id }
    }))
    const batch = batchCommand(project, commands, `删除 ${clips.length} 个片段`)
    try {
      dispatch(batch, updateMetaTime(applyCommand(project, batch)))
      setSelectedClipId(null)
      setSelectedClipIds(new Set())
      setMessage(`已删除 ${clips.length} 个片段`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批量删除失败')
    }
  }

  function startMultiDrag(event: React.PointerEvent, clip: TimelineClip): boolean {
    const draggable = allTimelineClips.filter((item) =>
      selectedClipIdsRef.current.has(item.id) &&
      !project.timeline.tracks.find((track) => track.id === item.trackId)?.locked
    )
    if (draggable.length < 2) return false
    const asset = project.media.find((item) => item.id === clip.mediaId)
    if (!asset || asset.duration <= 0) return false
    setSelectedClipId(clip.id)
    setPreviewSource({ mode: 'timeline', mediaId: clip.mediaId })
    setPreviewTime(clip.timelineStart)
    setMultiDrag({
      pointerId: event.pointerId,
      originX: event.clientX,
      anchorId: clip.id,
      clipIds: draggable.map((item) => item.id),
      startPositions: draggable.map((item) => ({
        clipId: item.id,
        trackId: item.trackId,
        timelineStart: item.timelineStart
      }))
    })
    setMultiDragDelta(0)
    return true
  }

  function localTimelinePoint(clientX: number, clientY: number) {
    const rect = timelineCanvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    }
  }

  function startMarquee(event: React.PointerEvent) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea')) return
    const point = localTimelinePoint(event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    setSelectedClipId(null)
    setSelectedClipIds(new Set())
    setMarquee({
      pointerId: event.pointerId,
      originX: point.x,
      originY: point.y,
      currentX: point.x,
      currentY: point.y
    })
  }

  function moveSelectedClip(direction: 'left' | 'right' | 'up' | 'down') {
    if (!selectedClip) return
    if (direction === 'left' || direction === 'right') {
      const timelineStart = Math.max(0, selectedClip.timelineStart + (direction === 'left' ? -0.25 : 0.25))
      const command: Command = {
        id: uid('cmd-move'),
        kind: 'clip.move',
        payload: { clipId: selectedClip.id, trackId: selectedClip.trackId, timelineStart }
      }
      dispatch(command, updateMetaTime(applyCommand(project, command)))
      return
    }
    const selectedTrack = project.timeline.tracks.find((track) => track.id === selectedClip.trackId)
    if (!selectedTrack) return
    const sameKind = project.timeline.tracks.filter((track) => track.kind === selectedTrack.kind)
    const currentIndex = sameKind.findIndex((track) => track.id === selectedClip.trackId)
    const target = sameKind[direction === 'up' ? currentIndex - 1 : currentIndex + 1]
    if (!target || target.locked) return
    const command: Command = {
      id: uid('cmd-move'),
      kind: 'clip.move',
      payload: {
        clipId: selectedClip.id,
        trackId: target.id,
        timelineStart: selectedClip.timelineStart
      }
    }
    dispatch(command, updateMetaTime(applyCommand(project, command)))
  }

  function changeSelectedClip(patch: Partial<TimelineClip>, label: string) {
    if (!selectedClip) return
    const track = project.timeline.tracks.find((item) => item.id === selectedClip.trackId)
    if (!track || track.locked) return
    const clips = track.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, ...patch } : clip)
    const command: Command = {
      id: uid('cmd-replace'),
      kind: 'track.replaceClips',
      payload: { trackId: track.id, clips }
    }
    dispatch(command, updateMetaTime(applyCommand(project, command)))
    setMessage(label)
  }

  function changeOpacity(value: number) {
    if (!selectedClip) return
    changeSelectedClip({
      transform: { ...selectedClip.transform, opacity: clamp(value, 0, 1) }
    }, '已更新透明度')
  }

  function updateEffectValue(value: number) {
    if (!selectedClip) return
    const range = effectRanges[selectedEffect]
    changeSelectedClip({
      transform: selectedEffect === 'position'
        ? { ...selectedClip.transform, x: clamp(value, range.min, range.max) }
        : { ...selectedClip.transform, [selectedEffect]: clamp(value, range.min, range.max) }
    }, `已更新${effectLabels[selectedEffect]}`)
  }

  function setEffectKeyframe() {
    if (!selectedClip) return
    const localTime = clamp(previewTime - selectedClip.timelineStart, 0, selectedClip.duration)
    const value = effectBaseValue(selectedClip.transform, selectedEffect)
    const command: Command = {
      id: uid('cmd-keyframe'),
      kind: 'clip.keyframe.set',
      payload: {
        clipId: selectedClip.id,
        property: selectedEffect,
        time: localTime,
        value
      }
    }
    try {
      dispatch(command, updateMetaTime(applyCommand(project, command)))
      setMessage(`已在 ${formatTime(localTime)} 设置${effectLabels[selectedEffect]}关键帧`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '关键帧设置失败')
    }
  }

  function removeEffectKeyframe(property: EffectKind, time: number) {
    if (!selectedClip) return
    const effects = selectedClip.effects
      .map((track) => track.property === property
        ? { ...track, keyframes: track.keyframes.filter((item) => Math.abs(item.time - time) > .001) }
        : track)
      .filter((track) => track.keyframes.length > 0)
    changeSelectedClip({ effects }, '关键帧已删除')
  }

  function toggleTrackState(track: Track, field: 'muted' | 'hidden' | 'locked') {
    const tracks = project.timeline.tracks.map((item) => item.id === track.id
      ? { ...item, [field]: !item[field] }
      : item)
    const next = updateMetaTime({ ...project, timeline: { ...project.timeline, tracks } })
    dispatch({ id: uid('cmd-track-state'), kind: 'project.set', payload: { project: next } }, next)
  }

  function addTrack(kind: TrackKind) {
    const track: Track = {
      id: uid(`track-${kind}`),
      kind,
      clips: [],
      locked: false,
      muted: false,
      hidden: false
    }
    const command: Command = { id: uid('cmd-track'), kind: 'track.add', payload: { track } }
    dispatch(command, updateMetaTime(applyCommand(project, command)))
    setMessage(`已添加${kind}轨道`)
  }

  function undo() {
    const entry = history.at(-1)
    if (!entry) return
    const inverse = entry.inverse ?? invertCommand(entry.command, project)
    if (!inverse) {
      setMessage('该操作无法撤销')
      return
    }
    try {
      setProjectState(updateMetaTime(normalizeTransforms(applyCommand(project, inverse))))
      setHistory((items) => items.slice(0, -1))
      setFuture((items) => [inverse, ...items])
      setDirty(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '撤销失败')
    }
  }

  function redo() {
    const command = future[0]
    if (!command) return
    try {
      const next = normalizeTransforms(applyCommand(project, command))
      setProjectState(updateMetaTime(next))
      setFuture((items) => items.slice(1))
      setHistory((items) => [
        ...items,
        { id: command.id, command, inverse: invertCommand(command, project), at: new Date().toISOString() }
      ])
      setDirty(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重做失败')
    }
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      } else if (event.key === 'Delete' && selectedClip) {
        event.preventDefault()
        if (selectedClipIds.size > 1) removeSelectedClips()
        else removeSelectedClip()
      } else if (event.key.toLowerCase() === 's' && selectedClip && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        if (selectedClipIds.size > 1) splitSelectedClips()
        else splitSelectedClip()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

  function startClipDrag(event: React.PointerEvent, clip: TimelineClip, mode: ClipDragMode) {
    const asset = project.media.find((item) => item.id === clip.mediaId)
    if (!asset || asset.duration <= 0) return
    event.preventDefault()
    event.stopPropagation()
    if (mode === 'move' && selectedClipIdsRef.current.has(clip.id) && startMultiDrag(event, clip)) return
    setSelectedClipId(clip.id)
    setPreviewSource({ mode: 'timeline', mediaId: clip.mediaId })
    setPreviewTime(clip.timelineStart)
    setClipDrag({
      clipId: clip.id,
      trackId: clip.trackId,
      mode,
      pointerId: event.pointerId,
      originX: event.clientX,
      timelineStart: clip.timelineStart,
      sourceStart: clip.sourceStart,
      duration: clip.duration
    })
    setClipDragPreview(null)
  }

  useEffect(() => {
    if (!clipDrag) return
    const drag = clipDrag

    function moveClip(delta: number) {
      const timelineStart = snapTime(Math.max(0, drag.timelineStart + delta), [drag.clipId])
      setClipDragPreview({
        clipId: drag.clipId,
        timelineStart,
        sourceStart: drag.sourceStart,
        duration: drag.duration
      })
    }

    function trimClip(delta: number) {
      const asset = project.media.find((item) => item.id ===
        project.timeline.tracks.flatMap((track) => track.clips)
          .find((clip) => clip.id === drag.clipId)?.mediaId)
      if (!asset) return
      if (drag.mode === 'trim-start') {
        const minStart = Math.max(0, drag.timelineStart - drag.sourceStart)
        const maxStart = drag.timelineStart + drag.duration - 0.05
        const timelineStart = clamp(drag.timelineStart + delta, minStart, maxStart)
        setClipDragPreview({
          clipId: drag.clipId,
          timelineStart,
          sourceStart: drag.sourceStart + (timelineStart - drag.timelineStart),
          duration: drag.duration
        })
        return
      }
      setClipDragPreview({
        clipId: drag.clipId,
        timelineStart: drag.timelineStart,
        sourceStart: drag.sourceStart,
        duration: clamp(drag.duration + delta, 0.05, asset.duration - drag.sourceStart)
      })
    }

    function handleMove(event: PointerEvent) {
      if (event.pointerId !== drag.pointerId) return
      const delta = (event.clientX - drag.originX) / zoom
      if (drag.mode === 'move') moveClip(delta)
      else trimClip(delta)
    }

    function handleUp(event: PointerEvent) {
      if (event.pointerId !== drag.pointerId) return
      const preview = clipDragPreview
      setClipDrag(null)
      setClipDragPreview(null)
      if (!preview) return
      if (drag.mode === 'move') {
        if (Math.abs(preview.timelineStart - drag.timelineStart) < 0.001) return
        const command: Command = {
          id: uid('cmd-drag'),
          kind: 'clip.move',
          payload: { clipId: drag.clipId, trackId: drag.trackId, timelineStart: preview.timelineStart }
        }
        dispatch(command, updateMetaTime(applyCommand(project, command)))
        return
      }
      const changed = Math.abs(preview.duration - drag.duration) > 0.001 ||
        Math.abs(preview.timelineStart - drag.timelineStart) > 0.001 ||
        Math.abs(preview.sourceStart - drag.sourceStart) > 0.001
      if (!changed) return
      const command: Command = {
        id: uid('cmd-trim'),
        kind: 'clip.trim',
        payload: {
          clipId: drag.clipId,
          timelineStart: preview.timelineStart,
          sourceStart: preview.sourceStart,
          duration: preview.duration
        }
      }
      dispatch(command, updateMetaTime(applyCommand(project, command)))
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [clipDrag, clipDragPreview, previewTime, project, snapping, zoom])

  useEffect(() => {
    if (!multiDrag) return
    const drag = multiDrag

    function handleGroupMove(event: PointerEvent) {
      if (event.pointerId !== drag.pointerId) return
      const rawDelta = (event.clientX - drag.originX) / zoom
      const maxBackward = Math.min(...drag.startPositions.map((item) => item.timelineStart))
      const anchorStart = drag.startPositions.find((item) => item.clipId === drag.anchorId)
        ?.timelineStart ?? 0
      const desiredAnchor = Math.max(0, anchorStart + rawDelta)
      const snappedAnchor = snapTime(desiredAnchor, drag.clipIds)
      setMultiDragDelta(clamp(snappedAnchor - anchorStart, -maxBackward, Number.MAX_SAFE_INTEGER))
    }

    function handleGroupUp(event: PointerEvent) {
      if (event.pointerId !== drag.pointerId) return
      const delta = multiDragDelta
      const commands: Command[] = drag.startPositions
        .filter((position) => Math.abs(delta) > .001)
        .map((position) => ({
          id: uid('cmd-move'),
          kind: 'clip.move' as const,
          payload: {
            clipId: position.clipId,
            trackId: position.trackId,
            timelineStart: Math.max(0, position.timelineStart + delta)
          }
        }))
      setMultiDrag(null)
      setMultiDragDelta(0)
      if (commands.length === 0) return
      try {
        const batch = batchCommand(project, commands, `移动 ${commands.length} 个片段`)
        dispatch(batch, updateMetaTime(applyCommand(project, batch)))
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '批量移动失败')
      }
    }

    window.addEventListener('pointermove', handleGroupMove)
    window.addEventListener('pointerup', handleGroupUp)
    window.addEventListener('pointercancel', handleGroupUp)
    return () => {
      window.removeEventListener('pointermove', handleGroupMove)
      window.removeEventListener('pointerup', handleGroupUp)
      window.removeEventListener('pointercancel', handleGroupUp)
    }
  }, [multiDrag, multiDragDelta, project, zoom])

  useEffect(() => {
    if (!marquee) return
    const selection = marquee

    function handleMarqueeMove(event: PointerEvent) {
      if (event.pointerId !== selection.pointerId) return
      const point = localTimelinePoint(event.clientX, event.clientY)
      if (!point) return
      setMarquee({ ...selection, currentX: point.x, currentY: point.y })
    }

    function handleMarqueeUp() {
      const canvasRect = timelineCanvasRef.current?.getBoundingClientRect()
      if (!canvasRect) {
        setMarquee(null)
        return
      }
      const left = Math.min(selection.originX, selection.currentX)
      const right = Math.max(selection.originX, selection.currentX)
      const top = Math.min(selection.originY, selection.currentY)
      const bottom = Math.max(selection.originY, selection.currentY)
      const selected = new Set<string>()
      let primary: string | null = null
      if (right - left > 3 || bottom - top > 3) {
        for (const track of project.timeline.tracks) {
          const body = timelineCanvasRef.current?.querySelector<HTMLElement>(`[data-track-id="${track.id}"]`)
          if (!body) continue
          const bodyRect = body.getBoundingClientRect()
          const bodyTop = bodyRect.top - canvasRect.top
          const bodyBottom = bodyTop + bodyRect.height
          if (bodyBottom < top || bodyTop > bottom) continue
          for (const clip of track.clips) {
            const clipLeft = clip.timelineStart * zoom
            const clipRight = clipLeft + Math.max(24, clip.duration * zoom)
            if (clipLeft <= right && clipRight >= left) {
              selected.add(clip.id)
              primary ??= clip.id
            }
          }
        }
      }
      setSelectedClipIds(selected)
      setSelectedClipId(primary)
      setMarquee(null)
    }

    window.addEventListener('pointermove', handleMarqueeMove)
    window.addEventListener('pointerup', handleMarqueeUp)
    window.addEventListener('pointercancel', handleMarqueeUp)
    return () => {
      window.removeEventListener('pointermove', handleMarqueeMove)
      window.removeEventListener('pointerup', handleMarqueeUp)
      window.removeEventListener('pointercancel', handleMarqueeUp)
    }
  }, [marquee, project.timeline.tracks, zoom])

  function handleClipPointerDown(event: React.PointerEvent, clip: TimelineClip, mode: ClipDragMode) {
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    if (additive) {
      event.preventDefault()
      event.stopPropagation()
      setSelectedClipIds((current) => {
        const next = new Set(current)
        if (next.has(clip.id)) {
          next.delete(clip.id)
        } else {
          next.add(clip.id)
        }
        return next
      })
      setSelectedClipId((current) => (current === clip.id ? null : clip.id))
      setPreviewSource({ mode: 'timeline', mediaId: clip.mediaId })
      setPreviewTime(clip.timelineStart)
      return
    }
    if (mode === 'move') {
      const extendsSelection = selectedClipIdsRef.current.has(clip.id)
      if (!extendsSelection) {
        selectedClipIdsRef.current = new Set([clip.id])
        setSelectedClipIds(selectedClipIdsRef.current)
      }
      startClipDrag(event, clip, mode)
      return
    }
    selectedClipIdsRef.current = new Set([clip.id])
    setSelectedClipIds(selectedClipIdsRef.current)
    startClipDrag(event, clip, mode)
  }

  function seekTimeline(clientX: number, element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    const time = clamp((clientX - rect.left) / zoom, 0, timelineSpan)
    const clip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((item) => time >= item.timelineStart && time < item.timelineStart + item.duration)
    setPreviewSource({ mode: 'timeline', mediaId: clip?.mediaId ?? previewSource.mediaId })
    setPreviewTime(time)
    if (clip) setSelectedClipId(clip.id)
  }

  function togglePlayback() {
    const video = previewRef.current
    if (!video) return
    if (video.paused) {
      void video.play()
      setPlaying(true)
    } else {
      video.pause()
      setPlaying(false)
    }
  }

  async function saveProject() {
    try {
      const documentText = serializeProject(project, { history, future })
      const response = await fetch('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: documentText
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '项目保存失败')
      setDirty(false)
      setMessage('项目已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '项目保存失败')
    }
  }

  function openProject(file: File) {
    file.text()
      .then((raw) => {
        const saved = deserializeProject(raw)
        const restored = normalizeTransforms(withDefaultTracks(saved.project))
        setProjectState(restored)
        setHistory(saved.history)
        setFuture(saved.future)
        setPreviewSource({ mode: 'media', mediaId: restored.media[0]?.id ?? null })
        setSelectedAssetId(restored.media[0]?.id ?? null)
        setDirty(false)
        setMessage('项目已打开')
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : '项目打开失败'))
  }

  async function exportProject(format: 'mp4' | MetadataFormat = 'mp4') {
    try {
      const issues = validateProject(project)
      if (issues.length > 0) throw new Error(issues[0]!.message)
      const exportPlan = timelineToExportPlan(project)
      if (exportPlan.video.length === 0 && exportPlan.audio.length === 0) {
        throw new Error('没有可导出的媒体片段')
      }
      for (const entry of exportPlan.video) {
        const clip = project.timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === entry.id)
        const asset = project.media.find((item) => item.id === clip?.mediaId)
        entry.hasAudio = asset?.audioChannels !== 0
      }
      setExporting(true)
      setExportProgress(0)
      const endpoint = format === 'mp4' ? '/api/export' : '/api/export/metadata'
      const requested = exportName.trim() || `exports/${Date.now()}.${format}`
      const output = format === 'mp4'
        ? requested
        : `${requested.replace(/\.(mp4|fcpxml|json)$/i, '')}.${format === 'fcpxml' ? 'fcpxml' : 'json'}`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(format === 'mp4'
          ? {
            plan: { ...exportPlan, quality: exportQualityMap[exportQuality] },
            output
          }
          : { plan: exportPlan, kind: format, output })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '导出失败')
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 450))
        const jobResponse = await fetch(`/api/jobs/${data.jobId}`)
        const job = await jobResponse.json()
        if (!jobResponse.ok) throw new Error(job.error ?? '导出任务查询失败')
        setExportProgress(typeof job.progress === 'number' ? job.progress : null)
        if (job.status === 'completed') {
          setExportProgress(1)
          setMessage(`导出完成：${job.result.output}`)
          return
        }
        if (job.status === 'failed') throw new Error(job.error ?? '导出失败')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  function generateCaptionsFromSpeech(asset: MediaAsset) {
    const segments = speechByAsset.get(asset.id) ?? []
    if (segments.length === 0) {
      setMessage('该素材还没有语音结果')
      return
    }
    const captionTrack = firstTrack('caption')
    if (!captionTrack) {
      setMessage('没有可用字幕轨')
      return
    }
    const existingTexts = new Set(
      project.timeline.tracks
        .find((track) => track.kind === 'caption')
        ?.clips.map((clip) => clip.text ?? '') ?? []
    )
    const videoTrack = project.timeline.tracks.find((track) => track.kind === 'video')
    const commands: Command[] = segments
      .filter((segment) => segment.text.trim() && !existingTexts.has(segment.text))
      .map((segment) => {
        const host = videoTrack?.clips.find((clip) =>
          clip.mediaId === asset.id &&
          clip.sourceStart <= segment.start &&
          segment.end <= clip.sourceStart + clip.duration
        )
        const timelineStart = host
          ? host.timelineStart + segment.start - host.sourceStart
          : segment.start
        const clip = makeClip(asset, captionTrack.id, timelineStart, segment.start, segment.end - segment.start)
        return {
          id: uid('cmd-caption'),
          kind: 'clip.add' as const,
          payload: { clip: { ...clip, text: segment.text } }
        }
      })
    if (commands.length === 0) {
      setMessage('字幕已存在')
      return
    }
    try {
      const next = commands.reduce(applyCommand, project)
      dispatch(batchCommand(project, commands, '生成字幕'), updateMetaTime(next))
      setMessage(`已生成 ${commands.length} 条字幕`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '字幕生成失败')
    }
  }

  const currentTrack = selectedClip
    ? project.timeline.tracks.find((track) => track.id === selectedClip.trackId)
    : null
  const selectedSpeech = selectedAsset ? speechByAsset.get(selectedAsset.id) ?? [] : speechSegments
  const selectedScenes = selectedAsset ? scenesByAsset.get(selectedAsset.id) ?? [] : []
  const selectedVisual = selectedAsset ? visualByAsset.get(selectedAsset.id) ?? [] : []

  return (
    <div className="workstation">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>AI Video Workstation</h1>
            <span>{project.media.length} 个素材 · {project.timeline.tracks.length} 条轨道</span>
          </div>
        </div>
        <input
          className="project-name"
          value={project.meta.name}
          onChange={(event) => renameProject(event.target.value)}
          aria-label="项目名称"
        />
        <div className="topbar-actions">
          <button onClick={undo} disabled={history.length === 0} title="撤销 Ctrl+Z">
            <svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
            撤销
          </button>
          <button onClick={redo} disabled={future.length === 0} title="重做 Ctrl+Shift+Z">
            <svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
            重做
          </button>
          <button onClick={() => void saveProject()} disabled={!dirty}>保存</button>
          <button onClick={() => projectFileRef.current?.click()}>打开</button>
          <input
            ref={projectFileRef}
            type="file"
            accept=".json,.aiwork.json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) openProject(file)
              event.target.value = ''
            }}
            className="hidden-file"
          />
          <button onClick={() => void exportProject('mp4')} disabled={exporting || serviceOnline === false}>
            {exporting ? (exportProgress === null ? '导出中' : `${Math.round(exportProgress * 100)}%`) : '导出'}
          </button>
          <span className={serviceOnline ? 'service online' : 'service offline'}>
            {serviceOnline === null ? '检测服务' : serviceOnline ? '在线' : '离线'}
          </span>
        </div>
      </header>

      <main className="workspace">
        <aside className="panel left-panel">
          <section className="panel-section">
            <div className="section-head">
              <h2>素材库</h2>
              <button onClick={() => void addAssetFromPath(assetPath)} disabled={importing}>
                {importing ? '读取中' : '导入'}
              </button>
            </div>
            <label className="field">
              <span>本地路径</span>
              <input
                value={assetPath}
                onChange={(event) => setAssetPath(event.target.value)}
                placeholder="D:/media/sample.mp4"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void addAssetFromPath(assetPath)
                }}
              />
            </label>
            <div className="asset-list">
              {project.media.map((asset) => {
                const speechCount = (speechByAsset.get(asset.id) ?? []).length
                const sceneCount = (scenesByAsset.get(asset.id) ?? []).length
                return (
                  <article
                    key={asset.id}
                    className={asset.id === selectedAssetId ? 'asset-item selected' : 'asset-item'}
                    onClick={() => {
                      setSelectedAssetId(asset.id)
                      setPreviewSource({ mode: 'media', mediaId: asset.id })
                      setPreviewTime(0)
                    }}
                  >
                    <div className="asset-meta">
                      <strong>{asset.name}</strong>
                      <span>{asset.kind} · {formatTime(asset.duration)}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</span>
                      <span>{speechCount ? `${speechCount} 段语音` : '未转录'}{asset.kind === 'video' && sceneCount ? ` · ${sceneCount} 个场景` : ''}</span>
                    </div>
                    <div className="asset-actions">
                      <button onClick={(event) => { event.stopPropagation(); addAssetToTimeline(asset) }}>时间线</button>
                      <button onClick={(event) => {
                        event.stopPropagation()
                        void analyzeAsset(asset, asset.kind === 'video' ? 'all' : 'speech')
                          .then(() => setMessage('素材分析完成'))
                          .catch((error) => setMessage(error instanceof Error ? error.message : '分析失败'))
                          .finally(() => {
                            if (asset.kind === 'video') void loadThumbnails(asset).catch(() => undefined)
                            void loadWaveform(asset).catch(() => undefined)
                          })
                      }}>分析</button>
                      <button className="danger" onClick={(event) => { event.stopPropagation(); removeAsset(asset) }}>移除</button>
                    </div>
                  </article>
                )
              })}
              {project.media.length === 0 ? <p className="empty">尚未导入素材</p> : null}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-head">
              <h2>语音与场景</h2>
              <button
                onClick={() => { if (selectedAsset) generateCaptionsFromSpeech(selectedAsset) }}
                disabled={!selectedAsset}
              >
                转字幕
              </button>
            </div>
            <div className="signal-list">
              {selectedSpeech.map((segment) => (
                <button
                  key={segment.id}
                  className="signal-item"
                  onClick={() => {
                    setPreviewSource({ mode: 'media', mediaId: segment.mediaId })
                    setPreviewTime(segment.start)
                  }}
                >
                  <span>{formatTime(segment.start)} - {formatTime(segment.end)}</span>
                  <p>{segment.text}</p>
                </button>
              ))}
              {selectedScenes.map((scene, index) => (
                <div key={`${scene.mediaId}-${index}`} className="scene-row">
                  <button
                    className="signal-item compact"
                    onClick={() => {
                      setPreviewSource({ mode: 'media', mediaId: scene.mediaId })
                      setPreviewTime(scene.start)
                    }}
                  >
                    <span>场景 {index + 1} · {formatTime(scene.start)} - {formatTime(scene.end)}</span>
                  </button>
                  <button onClick={() => { if (selectedAsset) addSceneToTimeline(selectedAsset, scene) }}>加入</button>
                </div>
              ))}
              {selectedVisual.length > 0 ? (
                <div className="visual-summary">
                  <strong>画面信号</strong>
                  <span>
                    平均运动 {(selectedVisual.reduce((total, item) => total + item.motion, 0) / selectedVisual.length).toFixed(2)} ·
                    亮度 {(selectedVisual.reduce((total, item) => total + item.brightness, 0) / selectedVisual.length).toFixed(2)} ·
                    饱和度 {(selectedVisual.reduce((total, item) => total + item.saturation, 0) / selectedVisual.length).toFixed(2)}
                  </span>
                </div>
              ) : null}
              {selectedSpeech.length === 0 && selectedScenes.length === 0 ? (
                <p className="empty">选择素材并点击“分析”</p>
              ) : null}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-head">
              <h2>AI 方案</h2>
              <button onClick={() => void generatePlan()} disabled={analyzing || project.media.length === 0}>
                {analyzing ? '分析中' : '生成'}
              </button>
            </div>
            <label className="field">
              <span>目标</span>
              <select value={planGoal} onChange={(event) => setPlanGoal(event.target.value as PlannerGoal)}>
                <option value="summary">概要剪辑</option>
                <option value="highlights">高光片段</option>
                <option value="tutorial">教程讲解</option>
              </select>
            </label>
            <label className="field">
              <span>目标时长</span>
              <input
                type="number"
                min={1}
                max={3600}
                value={targetSeconds}
                onChange={(event) => setTargetSeconds(clamp(Number(event.target.value) || 30, 1, 3600))}
              />
            </label>
            <label className="field">
              <span>剪辑意图</span>
              <textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                rows={3}
                placeholder="保留讲解、高能片段、快节奏开场"
              />
            </label>
            <label className="field">
              <span>解说声音</span>
              <select value={narrationVoice} onChange={(event) => {
                const voice = event.target.value
                setNarrationVoice(voice)
                updateNarrationSettings({ voice }, '解说声音已更新')
              }}>
                {narrationVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>{voice.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>解说语速</span>
              <select value={narrationRate} onChange={(event) => {
                const rate = event.target.value
                setNarrationRate(rate)
                updateNarrationSettings({ rate }, '解说语速已更新')
              }}>
                {narrationRates.map((rate) => (
                  <option key={rate.id} value={rate.id}>{rate.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>自动避让</span>
              <select value={narrationDucking ? 'on' : 'off'} onChange={(event) => {
                const enabled = event.target.value === 'on'
                setNarrationDucking(enabled)
                updateNarrationSettings({
                  audioDucking: { ...project.narrationSettings?.audioDucking, enabled }
                }, '解说混音避让已更新')
              }}>
                <option value="on">开启</option>
                <option value="off">关闭</option>
              </select>
            </label>
            <label className="field">
              <span>解说文本</span>
              <textarea
                value={narrationText}
                onChange={(event) => setNarrationText(event.target.value)}
                rows={3}
                placeholder="输入要生成的解说文案"
              />
            </label>
            <button
              className="wide"
              onClick={() => void generateNarration()}
              disabled={generatingNarration || serviceOnline === false}
            >
              {generatingNarration ? '生成中' : '生成解说语音'}
            </button>
            <button className="wide" onClick={generateDraftNarrations} disabled={!plan || plan.selectedIds.length === 0}>
              从方案生成解说
            </button>
            <button className="wide" onClick={() => void analyzeAllMedia()} disabled={analyzing}>
              {analysisLabel || '重新分析全部素材'}
            </button>
          </section>
        </aside>

        <section className="stage-shell">
          <div className="preview">
            <div className="preview-stage">
              {previewAsset && previewAsset.kind !== 'caption' ? (
                <video
                  ref={previewRef}
                  className="preview-video"
                  src={`/api/media/stream?path=${encodeURIComponent(previewAsset.path)}`}
                  style={activePreviewStyle}
                  controls={false}
                  playsInline
                  onTimeUpdate={(event) => {
                    const sourceTime = event.currentTarget.currentTime
                    if (previewSource.mode === 'timeline' && activeTimelineClip) {
                      setPreviewTime(activeTimelineClip.timelineStart + sourceTime - activeTimelineClip.sourceStart)
                    } else if (previewSource.mode === 'media') {
                      setPreviewTime(sourceTime)
                    }
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
              ) : (
                <div className="preview-placeholder">
                  {project.media.length === 0 ? '导入素材开始工作' : `${project.meta.width} × ${project.meta.height}`}
                </div>
              )}
              {activeCaption ? <div className="caption-overlay">{activeCaption}</div> : null}
              {activeNarration ? <div className="narration-overlay">{activeNarration}</div> : null}
            </div>
            <div className="transport">
              <button onClick={() => setPreviewTime(0)} title="回到开头">
                <svg viewBox="0 0 24 24"><path d="M19 5v14L8 12Z" /><path d="M5 5v14" /></svg>
              </button>
              <button onClick={togglePlayback} disabled={!previewAsset} title={playing ? '暂停' : '播放'}>
                {playing
                  ? <svg viewBox="0 0 24 24"><path d="M7 5v14" /><path d="M17 5v14" /></svg>
                  : <svg viewBox="0 0 24 24"><path d="M7 5v14l12-7Z" /></svg>}
              </button>
              <span>{formatTime(previewTime)} / {formatTime(previewSource.mode === 'timeline' ? duration : previewAsset?.duration ?? 0)}</span>
              <span>{previewSource.mode === 'timeline' ? '时间线预览' : '素材预览'}</span>
            </div>
          </div>

          <section className="timeline-shell">
            <div className="timeline-toolbar">
              <div>
                <button onClick={() => selectedClipIds.size > 1 ? splitSelectedClips() : splitSelectedClip()} disabled={!selectedClip}>拆分</button>
                <button
                  className="danger"
                  onClick={() => selectedClipIds.size > 1 ? removeSelectedClips() : removeSelectedClip()}
                  disabled={!selectedClip}
                >
                  删除
                </button>
                <button
                  className={snapping ? 'active' : ''}
                  onClick={() => setSnapping((value) => !value)}
                  title="吸附到片段边界、播放头和时间零点"
                >
                  吸附
                </button>
              </div>
              <div>
                <button onClick={() => addTrack('video')}>+视频</button>
                <button onClick={() => addTrack('audio')}>+音频</button>
                <button onClick={() => addTrack('caption')}>+字幕</button>
              </div>
              <div className="zoom-controls">
                <button onClick={() => setZoom((value) => clamp(value - 8, 12, 180))} aria-label="缩小">-</button>
                <span>{Math.round(zoom)} px/s</span>
                <button onClick={() => setZoom((value) => clamp(value + 8, 12, 180))} aria-label="放大">+</button>
              </div>
            </div>
            <div className="timeline-scroll">
              <div
                ref={timelineCanvasRef}
                className="timeline-canvas"
                style={{ width: 120 + timelineSpan * zoom + 40 }}
                onPointerDown={startMarquee}
              >
                <div
                  className="timeline-ruler"
                  style={{ width: timelineSpan * zoom }}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    seekTimeline(event.clientX, event.currentTarget)
                  }}
                  onPointerMove={(event) => {
                    if (event.buttons === 1) seekTimeline(event.clientX, event.currentTarget)
                  }}
                >
                  {Array.from({ length: Math.ceil(timelineSpan) + 1 }, (_, index) => index).map((second) => (
                    <span key={second} className="ruler-tick" style={{ left: second * zoom }}>{second}s</span>
                  ))}
                </div>
                {project.timeline.tracks.map((track) => (
                  <div key={track.id} className="track-row">
                    <div className="track-head">
                      <div className="track-title">
                        <span className="track-kind">{trackIcon(track.kind)}</span>
                        <strong>{track.kind}</strong>
                      </div>
                      <div className="track-controls">
                        <button className={track.muted ? 'active' : ''} onClick={() => toggleTrackState(track, 'muted')} title="静音">M</button>
                        <button className={track.hidden ? 'active' : ''} onClick={() => toggleTrackState(track, 'hidden')} title="隐藏">H</button>
                        <button className={track.locked ? 'active' : ''} onClick={() => toggleTrackState(track, 'locked')} title="锁定">L</button>
                      </div>
                    </div>
                    <div className="track-body" data-track-id={track.id} style={{ width: timelineSpan * zoom }}>
                      {track.clips.map((clip) => {
                        const singlePreview = clipDragPreview?.clipId === clip.id ? clipDragPreview : null
                        const multiPreview = multiDrag && selectedClipIds.has(clip.id)
                          ? {
                            timelineStart: clip.timelineStart + multiDragDelta,
                            sourceStart: clip.sourceStart,
                            duration: clip.duration
                          }
                          : null
                        const preview = singlePreview ?? multiPreview
                        const view = preview ?? clip
                        return (
                          <div
                            key={clip.id}
                            data-clip-id={clip.id}
                            className={[
                              'timeline-clip',
                              clip.id === selectedClipId ? 'selected' : '',
                              selectedClipIds.has(clip.id) ? 'multi-selected' : '',
                              preview ? 'dragging' : '',
                              track.kind === 'caption' ? 'caption' : ''
                            ].filter(Boolean).join(' ')}
                            style={{
                              left: view.timelineStart * zoom,
                              width: Math.max(24, view.duration * zoom)
                            }}
                            onPointerDown={(event) => handleClipPointerDown(event, clip, 'move')}
                          >
                            <span>{clip.text ? clip.text : clip.narration ? clip.narration : formatTime(view.duration)}</span>
                            {track.kind === 'video' && thumbnails[clip.mediaId] ? (
                              <div className="clip-thumbnail-strip">
                                {thumbnails[clip.mediaId]!.map((thumb) => (
                                  <img key={`${clip.id}-${thumb.time}`} src={thumb.dataUrl} alt="" />
                                ))}
                              </div>
                            ) : null}
                            {(track.kind === 'audio' || track.kind === 'music') && waveforms[clip.mediaId] ? (
                              <div className="clip-waveform" aria-hidden="true">
                                {waveforms[clip.mediaId]!.map((value, index) => (
                                  <span key={`${clip.id}-${index}`} style={{ height: `${Math.max(6, value * 100)}%` }} />
                                ))}
                              </div>
                            ) : null}
                            <span
                              className="clip-handle start"
                              onPointerDown={(event) => handleClipPointerDown(event, clip, 'trim-start')}
                              aria-label="裁剪开头"
                            />
                            <span
                              className="clip-handle end"
                              onPointerDown={(event) => handleClipPointerDown(event, clip, 'trim-end')}
                              aria-label="裁剪结尾"
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
                {marquee ? (
                  <div
                    className="marquee-box"
                    style={{
                      left: Math.min(marquee.originX, marquee.currentX),
                      top: Math.min(marquee.originY, marquee.currentY),
                      width: Math.abs(marquee.currentX - marquee.originX),
                      height: Math.abs(marquee.currentY - marquee.originY)
                    }}
                  />
                ) : null}
                <div className="playhead" style={{ left: 120 + previewTime * zoom }} />
              </div>
            </div>
          </section>
        </section>

        <aside className="panel right-panel">
          <section className="panel-section">
            <div className="section-head">
              <h2>方案审核</h2>
              <button onClick={() => void applyPlan()} disabled={!plan || plan.selectedIds.length === 0}>应用</button>
            </div>
            {plan ? (
              <>
                <div className="strategy-tabs">
                  {plan.strategies.map((strategy) => (
                    <button
                      key={strategy.id}
                      className={strategy.id === plan.strategyId ? 'active' : ''}
                      onClick={() => choosePlanStrategy(strategy.id)}
                    >
                      {strategy.label}
                    </button>
                  ))}
                </div>
                <p className="plan-description">
                  {plan.strategies.find((item) => item.id === plan.strategyId)?.description}
                </p>
                <p className="plan-summary">
                  {plan.selectedIds.length}/{plan.segments.length} · {plan.selectedDuration.toFixed(2)}s / 目标 {plan.targetSeconds}s
                </p>
                <div className="plan-list">
                  {plan.segments.map((segment) => {
                    const accepted = plan.selectedIds.includes(segment.id)
                    const reviewed = reviewedSegmentIds.has(segment.id)
                    return (
                      <article key={segment.id} className={accepted ? 'plan-card accepted' : 'plan-card'}>
                        <header>
                          <strong>{segment.title}</strong>
                          <span>{formatTime(segment.source.start)}</span>
                        </header>
                        <p>{segment.transcript || segment.summary || '无语音文本'}</p>
                        <p className="plan-transition">
                          转场建议：{transitionLabel(segment.transition)}
                        </p>
                        {segment.narration ? (
                          <p className="plan-narration">解说：{segment.narration}</p>
                        ) : null}
                        <ul className="factor-list">
                          {segment.factors.map((factor) => (
                            <li key={factor.id}>
                              <span>{factor.label}</span>
                              <span>{Math.round(factor.value * factor.weight * 100)}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="review-state">{reviewed ? (accepted ? '已采纳' : '已拒绝') : '待审核'}</p>
                        <div className="plan-actions">
                          <button className={accepted ? 'active' : ''} onClick={() => toggleSegment(segment.id, true)}>采纳</button>
                          <button onClick={() => toggleSegment(segment.id, false)}>拒绝</button>
                        </div>
                      </article>
                    )
                  })}
                </div>
                <div className="plan-bulk">
                  <button onClick={acceptAllSegments}>全部采纳</button>
                  <button onClick={clearPlan}>清除</button>
                </div>
              </>
            ) : (
              <p className="empty">生成方案后可逐段审核</p>
            )}
          </section>

          <section className="panel-section">
            <div className="section-head"><h2>属性与字幕</h2></div>
            {selectedClip ? (
              <div className="inspector-grid">
                <div><span>轨道</span><strong>{currentTrack?.kind ?? selectedClip.trackId}</strong></div>
                <div><span>时间线</span><strong>{formatTime(selectedClip.timelineStart)}</strong></div>
                <div><span>时长</span><strong>{selectedClip.duration.toFixed(2)}s</strong></div>
                <div><span>源起点</span><strong>{selectedClip.sourceStart.toFixed(2)}s</strong></div>
                <label className="field">
                  <span>字幕文本</span>
                  <textarea
                    value={selectedClip.text ?? ''}
                    rows={3}
                    onChange={(event) => changeSelectedClip({ text: event.target.value }, '字幕已更新')}
                  />
                </label>
                <label className="field">
                  <span>解说文本</span>
                  <textarea
                    value={selectedClip.narration ?? ''}
                    rows={2}
                    onChange={(event) => changeSelectedClip({ narration: event.target.value }, '解说文本已更新')}
                  />
                </label>
                <label className="field">
                  <span>入点转场</span>
                  <select
                    value={selectedClip.transitionIn ?? 'none'}
                    onChange={(event) => changeSelectedClip(
                      { transitionIn: event.target.value as TransitionKind },
                      '入点转场已更新'
                    )}
                  >
                    <option value="none">无</option>
                    <option value="fade">淡入</option>
                    <option value="dissolve">叠化</option>
                    <option value="wipe-left">左擦入</option>
                    <option value="wipe-right">右擦入</option>
                    <option value="slide-left">左滑入</option>
                    <option value="slide-right">右滑入</option>
                  </select>
                </label>
                <label className="field">
                  <span>出点转场</span>
                  <select
                    value={selectedClip.transitionOut ?? 'none'}
                    onChange={(event) => changeSelectedClip(
                      { transitionOut: event.target.value as TransitionKind },
                      '出点转场已更新'
                    )}
                  >
                    <option value="none">无</option>
                    <option value="fade">淡出</option>
                    <option value="dissolve">叠化</option>
                    <option value="wipe-left">左擦出</option>
                    <option value="wipe-right">右擦出</option>
                    <option value="slide-left">左滑出</option>
                    <option value="slide-right">右滑出</option>
                  </select>
                </label>
                <label className="range">
                  <span>透明度</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedClip.transform.opacity}
                    onChange={(event) => changeOpacity(Number(event.target.value))}
                  />
                  <strong>{selectedClip.transform.opacity.toFixed(2)}</strong>
                </label>
                <label className="range">
                  <span>音量</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={.01}
                    value={selectedClip.volume}
                    onChange={(event) => changeSelectedClip({ volume: clamp(Number(event.target.value), 0, 2) }, '已更新音量')}
                  />
                  <strong>{selectedClip.volume.toFixed(2)}</strong>
                </label>
                <label className="field">
                  <span>效果</span>
                  <select
                    aria-label="效果属性"
                    value={selectedEffect}
                    onChange={(event) => setSelectedEffect(event.target.value as EffectKind)}
                  >
                    {Object.entries(effectLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="range">
                  <span>数值</span>
                  <input
                    type="range"
                    min={effectRanges[selectedEffect].min}
                    max={effectRanges[selectedEffect].max}
                    step={effectRanges[selectedEffect].step}
                    value={effectBaseValue(selectedClip.transform, selectedEffect)}
                    onChange={(event) => updateEffectValue(Number(event.target.value))}
                  />
                  <strong>{effectBaseValue(selectedClip.transform, selectedEffect).toFixed(2)}</strong>
                </label>
                <button onClick={setEffectKeyframe}>在播放头设关键帧</button>
                {selectedClip.effects.length > 0 ? (
                  <div className="keyframe-list">
                    {selectedClip.effects.map((track) => (
                      <div key={track.property} className="keyframe-group">
                        <strong>{effectLabels[track.property]}</strong>
                        <ul>
                          {track.keyframes.map((keyframe, index) => (
                            <li key={`${keyframe.time}-${index}`}>
                              <span>{formatTime(keyframe.time)} · {keyframe.value.toFixed(2)}</span>
                              <button onClick={() => removeEffectKeyframe(track.property, keyframe.time)}>删除</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="move-grid">
                  <button onClick={() => moveSelectedClip('left')}>左移</button>
                  <button onClick={() => moveSelectedClip('up')}>上移</button>
                  <button onClick={() => moveSelectedClip('right')}>右移</button>
                  <button onClick={() => moveSelectedClip('down')}>下移</button>
                </div>
              </div>
            ) : <p className="empty">选择时间线片段查看属性</p>}
          </section>

          <section className="panel-section">
            <div className="section-head"><h2>导出设置</h2></div>
            <label className="field">
              <span>画质</span>
              <select value={exportQuality} onChange={(event) => setExportQuality(event.target.value as ExportQuality)}>
                <option value="fast">快速</option>
                <option value="balanced">均衡</option>
                <option value="quality">高画质</option>
              </select>
            </label>
            <div className="setting-grid">
              <label className="field">
                <span>分辨率</span>
                <select
                  value={`${project.meta.width}x${project.meta.height}`}
                  onChange={(event) => {
                    const [rawWidth, rawHeight] = event.target.value.split('x')
                    const width = Number(rawWidth)
                    const height = Number(rawHeight)
                    if (Number.isFinite(width) && Number.isFinite(height)) {
                      updateProjectMeta({ width, height }, '导出分辨率已更新')
                    }
                  }}
                >
                  <option value="1920x1080">1080p</option>
                  <option value="1280x720">720p</option>
                  <option value="854x480">480p</option>
                  <option value="3840x2160">4K</option>
                </select>
              </label>
              <label className="field">
                <span>帧率</span>
                <select
                  value={project.meta.frameRate}
                  onChange={(event) => updateProjectMeta({ frameRate: Number(event.target.value) }, '帧率已更新')}
                >
                  <option value={24}>24</option>
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>输出文件</span>
              <input value={exportName} onChange={(event) => setExportName(event.target.value)} />
            </label>
            <p className="export-note">
              解说混音：自动避让{narrationDucking ? '开启' : '关闭'}；解说在时间线中的音量单独生效。
            </p>
            <div className="export-grid">
              <button onClick={() => void exportProject('mp4')} disabled={exporting || serviceOnline === false}>MP4</button>
              <button onClick={() => void exportProject('fcpxml')} disabled={exporting}>FCPXML</button>
              <button onClick={() => void exportProject('jianying')} disabled={exporting}>剪映草稿</button>
            </div>
          </section>
        </aside>
      </main>

      <footer className="statusbar">
        <span>{project.meta.name}</span>
        <span>{formatTime(duration)}</span>
        <span>{project.meta.width}×{project.meta.height} · {project.meta.frameRate}fps</span>
        <span>{dirty ? '自动保存中' : '已保存'}</span>
        <span className="message">{message}</span>
      </footer>
    </div>
  )
}
