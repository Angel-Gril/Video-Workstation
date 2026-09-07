import { projectDuration } from './reducer'
import type { Project, TimelineClip } from './types'

export interface ExportPlanEntry {
  id: string
  path: string
  sourceStart: number
  timelineStart: number
  duration: number
  trackId?: string
  transform?: TimelineClip['transform']
  text?: string
  volume?: number
  hasAudio?: boolean | undefined
  muted?: boolean | undefined
  effects?: TimelineClip['effects']
  transitionIn?: TimelineClip['transitionIn']
  transitionOut?: TimelineClip['transitionOut']
  narration?: string
  narrationPending?: boolean
  narrationVoice?: string
  narrationRate?: string
}

export interface ExportPlan {
  meta: Project['meta']
  narrationVoice?: string | undefined
  narrationRate?: string | undefined
  audioDucking?: {
    enabled?: boolean | undefined
    gain?: number | undefined
    attack?: number | undefined
    release?: number | undefined
  } | undefined
  video: ExportPlanEntry[]
  audio: ExportPlanEntry[]
  caption: ExportPlanEntry[]
  music: ExportPlanEntry[]
}

export function clipToPlanEntry(project: Project, clip: TimelineClip): ExportPlanEntry {
  const asset = project.media.find((item) => item.id === clip.mediaId)
  if (!asset) throw new Error(`Export clip references missing media: ${clip.id}`)
  const track = project.timeline.tracks.find((item) => item.id === clip.trackId)
  const entry: ExportPlanEntry = {
    id: clip.id,
    trackId: clip.trackId,
    path: asset.path,
    sourceStart: clip.sourceStart,
    timelineStart: clip.timelineStart,
    duration: clip.duration,
    transform: clip.transform,
    volume: clip.volume
  }

  if (track?.muted) entry.muted = true
  if (clip.transitionIn) entry.transitionIn = clip.transitionIn
  if (clip.transitionOut) entry.transitionOut = clip.transitionOut
  if (clip.effects.length > 0) entry.effects = clip.effects

  if (clip.text !== undefined) entry.text = clip.text
  if (clip.narration !== undefined) entry.narration = clip.narration
  if (clip.narrationPending) entry.narrationPending = true
  if (clip.narrationVoice !== undefined) entry.narrationVoice = clip.narrationVoice
  if (clip.narrationRate !== undefined) entry.narrationRate = clip.narrationRate
  return entry
}

export function createTimelinePlan(project: Project): ExportPlan {
  const empty: Record<Project['timeline']['tracks'][number]['kind'], ExportPlanEntry[]> = {
    video: [],
    audio: [],
    caption: [],
    music: []
  }

  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      empty[track.kind].push(clipToPlanEntry(project, clip))
    }
  }

  for (const kind of Object.keys(empty) as Array<keyof typeof empty>) {
    empty[kind].sort((a, b) => a.timelineStart - b.timelineStart)
  }

  return {
    meta: project.meta,
    narrationVoice: project.narrationSettings?.voice,
    narrationRate: project.narrationSettings?.rate,
    audioDucking: project.narrationSettings?.audioDucking,
    video: empty.video,
    audio: empty.audio,
    caption: empty.caption,
    music: empty.music
  }
}

export function timelineToExportPlan(project: Project): ExportPlan {
  const plan = createTimelinePlan(project)
  const hiddenTrackIds = new Set(
    project.timeline.tracks
      .filter((track) => track.hidden)
      .map((track) => track.id)
  )

  return {
    ...plan,
    video: plan.video.filter((clip) => !hiddenTrackIds.has(clip.trackId ?? '')),
    audio: plan.audio.filter((clip) => !hiddenTrackIds.has(clip.trackId ?? '')),
    music: plan.music.filter((clip) => !hiddenTrackIds.has(clip.trackId ?? ''))
  }
}

const fcpxmlRate = 30

function fcpxmlTime(value: number): string {
  return `${Math.max(0, Math.round(value * fcpxmlRate))}/${fcpxmlRate}s`
}

function fcpxmlTransform(project: Project, clip: TimelineClip): string {
  const offsetX = `${((clip.transform.x || 0) / Math.max(1, project.meta.width) * 100).toFixed(3)}%`
  const offsetY = `${((clip.transform.y || 0) / Math.max(1, project.meta.height) * 100).toFixed(3)}%`
  return ` offset="${offsetX} ${offsetY}" scale="${clip.transform.scale || 1}" rotate="${clip.transform.rotation || 0}"`
}

export function timelineToFCPXML(project: Project): string {
  const assetIds = new Map(project.media.map((asset, index) => [asset.id, `asset-${index + 1}`]))
  const videoTrack = project.timeline.tracks.find((track) => track.kind === 'video')
  const captionTrack = project.timeline.tracks.find((track) => track.kind === 'caption')
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!DOCTYPE fcpxml><fcpxml version="1.10"><resources><format id="format-1" name="FFVideoFormat1080p${project.meta.frameRate}" width="${project.meta.width}" height="${project.meta.height}" frameDuration="1/${project.meta.frameRate}s"/>`,
  ]
  for (const [index, asset] of project.media.entries()) {
    lines.push(
      `<format id="asset-format-${index + 1}" width="${asset.width ?? project.meta.width}" height="${asset.height ?? project.meta.height}" frameDuration="1/${asset.frameRate ?? project.meta.frameRate}s"/>`,
      `<asset id="${assetIds.get(asset.id)}" name="${escapeXml(asset.name)}" src="file:///${encodeURI(asset.path.replace(/\\/g, '/')).replace(/^\/?/, '')}" start="0s" duration="${fcpxmlTime(asset.duration)}" hasVideo="${asset.kind === 'audio' ? 0 : 1}" hasAudio="${asset.audioChannels ? 1 : 0}" format="asset-format-${index + 1}"/>`
    )
  }
    lines.push('</resources><library><event name="AI Video Workstation"><project name="' + escapeXml(project.meta.name) + '"><sequence format="format-1" duration="' + fcpxmlTime(projectDuration(project)) + '" tcFormat="NDF"><spine>')
  for (const clip of videoTrack?.clips ?? []) {
    const asset = project.media.find((item) => item.id === clip.mediaId)
    if (!asset) continue
    lines.push(
      `<asset-clip ref="${assetIds.get(asset.id)}" name="${escapeXml(asset.name)}" offset="${fcpxmlTime(clip.timelineStart)}" start="${fcpxmlTime(clip.sourceStart)}" duration="${fcpxmlTime(clip.duration)}"${fcpxmlTransform(project, clip)}><note>${escapeXml(clip.text ?? '')}</note></asset-clip>`
    )
  }
  lines.push('</spine>')
  if (captionTrack) {
    lines.push(`<lane offset="0s"><asset-clip ref="${assetIds.get(captionTrack.clips[0]?.mediaId ?? '')}" name="captions" offset="0s" start="0s" duration="${fcpxmlTime(projectDuration(project))}">`)
    for (const clip of captionTrack.clips) {
      lines.push(`<note>${escapeXml(clip.text ?? '')}</note>`)
    }
    lines.push('</asset-clip></lane>')
  }
  lines.push('</sequence></project></event></library></fcpxml>')
  return lines.join('')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
