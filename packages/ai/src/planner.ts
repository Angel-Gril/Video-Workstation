import type {
  NarrativePlan,
  PlanCommand,
  PlanFactor,
  PlanStrategy,
  PlannerInput,
  PlannerOptions,
  PlanWeights,
  StorySegment
} from './types'

interface Candidate {
  mediaId: string
  start: number
  end: number
  sceneScore: number
  speechScore: number
  intentScore: number
  durationScore: number
  visualScore: number
  matchedKeywords: string[]
  titleKeywords: string[]
  overlapIds: string[]
  transcript: string
  visual: {
    motion: number
    brightness: number
    saturation: number
    labels: string[]
  }
}

export const planStrategies: PlanStrategy[] = [
  {
    id: 'balanced',
    label: '均衡',
    description: '兼顾画面变化、语音密度、意图命中和片段节奏。',
    weights: { scene: 0.26, speech: 0.22, intent: 0.16, duration: 0.10, visual: 0.14, keyword: 0.12 }
  },
  {
    id: 'visual',
    label: '视觉优先',
    description: '优先保留画面变化明显的高能片段。',
    weights: { scene: 0.32, speech: 0.10, intent: 0.10, duration: 0.10, visual: 0.24, keyword: 0.14 }
  },
  {
    id: 'speech',
    label: '叙述优先',
    description: '优先保留完整、密集的讲解与关键语句。',
    weights: { scene: 0.10, speech: 0.36, intent: 0.18, duration: 0.08, visual: 0.10, keyword: 0.18 }
  }
]

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function makeFactors(candidate: Candidate, weights: PlanStrategy['weights']): PlanFactor[] {
  const factors: PlanFactor[] = [
    {
      id: 'scene',
      label: '场景变化',
      value: candidate.sceneScore,
      weight: weights.scene,
      detail: `源画面变化评分 ${candidate.sceneScore.toFixed(2)}`
    },
    {
      id: 'speech',
      label: '语音密度',
      value: candidate.speechScore,
      weight: weights.speech,
      detail: `语音覆盖 ${Math.round(candidate.speechScore * 100)}%`
    },
    {
      id: 'intent',
      label: '意图命中',
      value: candidate.intentScore,
      weight: weights.intent,
      detail: candidate.matchedKeywords.length
        ? `命中：${candidate.matchedKeywords.join('、')}`
        : '未命中意图关键词'
    },
    {
      id: 'duration',
      label: '片段节奏',
      value: candidate.durationScore,
      weight: weights.duration,
      detail: `时长 ${Math.round(candidate.end - candidate.start)}s`
    }
  ]
  if (candidate.visualScore > 0) {
    factors.push({
      id: 'visual',
      label: '画面信号',
      value: candidate.visualScore,
      weight: weights.visual ?? 0,
      detail: `运动 ${candidate.visual.motion.toFixed(2)} · 亮度 ${candidate.visual.brightness.toFixed(2)} · 饱和度 ${candidate.visual.saturation.toFixed(2)}${candidate.visual.labels.length ? ` · 线索 ${candidate.visual.labels.join('、')}` : ''}`
    })
  }
  if (candidate.titleKeywords.length > 0) {
    factors.push({
      id: 'keyword',
      label: '标题关键词',
      value: Math.min(1, candidate.titleKeywords.length * .28),
      weight: weights.keyword ?? 0,
      detail: `场景标题线索：${candidate.titleKeywords.join('、')}`
    })
  }
  return factors
}

function scoreOf(factors: PlanFactor[]): number {
  return clampNumber(
    factors.reduce((total, factor) => total + factor.value * factor.weight, 0),
    0,
    1
  )
}

function makeReasons(candidate: Candidate, factors: PlanFactor[]): string[] {
  const reasons: string[] = []
  const strongest = [...factors].sort((a, b) => b.value * b.weight - a.value * a.weight)[0]
  if (strongest && strongest.value > 0.2) reasons.push(`${strongest.label}：${strongest.detail}`)
  if (candidate.matchedKeywords.length > 0) {
    reasons.push(`与剪辑意图相关：${candidate.matchedKeywords.join('、')}`)
  }
  if (candidate.titleKeywords.length > 0) {
    reasons.push(`场景关键词：${candidate.titleKeywords.join('、')}`)
  }
  if (candidate.durationScore < 0.25) reasons.push('片段过短或过长，建议先接受再手动裁剪')
  if (candidate.visualScore > 0) {
    reasons.push(candidate.visual.labels.length
      ? `画面线索：${candidate.visual.labels.join('、')}（运动 ${candidate.visual.motion.toFixed(2)}）`
      : `画面运动 ${candidate.visual.motion.toFixed(2)}，亮度 ${candidate.visual.brightness.toFixed(2)}`)
  }
  if (reasons.length === 0) reasons.push('综合信号较弱，适合作为备选素材')
  return reasons
}

function buildNarration(
  goal: PlannerInput['goal'],
  candidate: Candidate,
  keywords: string[],
  index: number
): string {
  const spoken = candidate.transcript.replace(/\s+/g, ' ').trim()
  const focus = keywords.find((keyword) => candidate.matchedKeywords.includes(keyword))
  const lead = goal === 'highlights'
    ? `第 ${index + 1} 段高光，`
    : goal === 'tutorial'
      ? `接下来看第 ${index + 1} 部分，`
      : `第 ${index + 1} 部分，`
  if (!spoken) return `${lead}这一段画面变化明显，建议单独确认细节。`
  const compact = spoken.length > 38 ? `${spoken.slice(0, 37)}…` : spoken
  return `${lead}${focus ? `${focus}相关内容：` : ''}${compact}`
}

function candidateWindows(input: PlannerInput): Candidate[] {
  const scenes = [...input.scenes].sort((a, b) => a.start - b.start)
  const windows = scenes.length > 0
    ? scenes.map((scene) => ({
        mediaId: scene.mediaId,
        start: scene.start,
        end: scene.end,
        sceneScore: clampNumber(scene.score, 0, 1),
        visualScore: 0
      }))
    : input.transcript.map((segment) => ({
        mediaId: segment.mediaId,
        start: segment.start,
        end: segment.end,
        sceneScore: 0.35,
        visualScore: 0
      }))

  const keywords = (input.instruction ?? '')
    .toLowerCase()
    .split(/[\s,，。;；]+/)
    .filter((keyword) => keyword.length > 1)

  return windows
    .filter((window) => window.end > window.start)
    .map((window) => {
      const speech = input.transcript.filter(
        (segment) =>
          segment.mediaId === window.mediaId &&
          segment.start < window.end &&
          segment.end > window.start
      )
      const speechSeconds = speech.reduce(
        (total, segment) => total + (Math.min(segment.end, window.end) - Math.max(segment.start, window.start)),
        0
      )
      const duration = window.end - window.start
      const text = speech.map((segment) => segment.text).join(' ').toLowerCase()
      const matchedKeywords = keywords.filter((keyword) => text.includes(keyword))
      const titleKeywords = keywords.filter((keyword) => (
        text.includes(keyword) ||
        [...keyword].some((char) => text.includes(char))
      ))
      const overlappingSignals = (input.visualSignals ?? []).filter((signal) =>
        signal.mediaId === window.mediaId &&
        signal.start < window.end &&
        signal.end > window.start
      )
      const visualScore = overlappingSignals.length > 0
        ? clampNumber(
          overlappingSignals.reduce((total, signal) => total + signal.motion, 0) /
          overlappingSignals.length,
          0,
          1
        )
        : 0
      const brightness = overlappingSignals.length > 0
        ? overlappingSignals.reduce((total, signal) => total + signal.brightness, 0) / overlappingSignals.length
        : 0
      const saturation = overlappingSignals.length > 0
        ? overlappingSignals.reduce((total, signal) => total + signal.saturation, 0) / overlappingSignals.length
        : 0
      const labelCounts = new Map<string, number>()
      for (const signal of overlappingSignals) {
        for (const label of [...(signal.labels ?? []), ...signal.objects.map((item) => item.name)]) {
          labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
        }
      }
      const labels = [...labelCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([label]) => label)

      return {
        mediaId: window.mediaId,
        start: window.start,
        end: window.end,
        sceneScore: clampNumber(window.sceneScore, 0, 1),
        speechScore: duration > 0 ? clampNumber(speechSeconds / duration, 0, 1) : 0,
        intentScore: clampNumber(matchedKeywords.length * 0.42, 0, 1),
        durationScore: duration >= 2 && duration <= 25 ? 0.85 : duration < 2 ? 0.3 : 0.55,
        visualScore,
        visual: { motion: visualScore, brightness, saturation, labels },
        matchedKeywords,
        titleKeywords,
        overlapIds: speech.map((segment) => segment.id),
        transcript: speech.map((segment) => segment.text.trim()).filter(Boolean).join(' ')
      }
    })
    .sort((a, b) => a.start - b.start)
}

const weightIds: Array<PlanFactor['id']> = ['scene', 'speech', 'intent', 'duration', 'visual', 'keyword']

function normalizedWeights(
  strategy: PlanStrategy['weights'],
  overrides: PlanWeights | undefined
): PlanStrategy['weights'] {
  const maxRelativeWeight = 10
  const values = weightIds.map((id) => ({
    id,
    value: clampNumber(overrides?.[id] ?? strategy[id], 0, maxRelativeWeight)
  }))
  const total = values.reduce((sum, item) => sum + item.value, 0)
  if (total <= 0) {
    return Object.fromEntries(weightIds.map((id) => [id, 0])) as PlanStrategy['weights']
  }
  return Object.fromEntries(values.map((item) => [item.id, item.value / total])) as PlanStrategy['weights']
}

function selectSegments(
  input: PlannerInput,
  candidates: Candidate[],
  weights: PlanStrategy['weights']
): { segments: StorySegment[]; selectedIds: string[] } {
  const target = clampNumber(input.targetSeconds, 1, 3600)
  const keywords = (input.instruction ?? '')
    .toLowerCase()
    .split(/[\s,，。;；]+/)
    .filter((keyword) => keyword.length > 1)
  const scored = [...candidates]
    .map((candidate) => {
      const factors = makeFactors(candidate, weights)
      return { candidate, factors, score: scoreOf(factors) }
    })
    .sort((a, b) => b.score - a.score)

  const selected: Array<{
    candidate: Candidate
    factors: PlanFactor[]
    score: number
  }> = []
  let total = 0
  let guard = 0

  for (const item of scored) {
    if (selected.length > 0 && total >= target) break
    if (guard++ > scored.length) break
    const duration = item.candidate.end - item.candidate.start
    const remaining = target - total
    if (duration > remaining) {
      const nextCandidate: Candidate = { ...item.candidate, end: item.candidate.start + remaining }
      const nextFactors = makeFactors(nextCandidate, weights)
      selected.push({
        candidate: nextCandidate,
        factors: nextFactors,
        score: scoreOf(nextFactors)
      })
      total += remaining
      break
    }
    selected.push({ candidate: item.candidate, factors: item.factors, score: item.score })
    total += duration
  }

  const segments = selected
    .sort((a, b) => a.candidate.start - b.candidate.start)
    .map((item, index) => ({
      id: `story-${index + 1}`,
      title: `选段 ${index + 1}`,
      summary: '',
      selected: true,
      source: {
        mediaId: item.candidate.mediaId,
        start: Number(item.candidate.start.toFixed(3)),
        end: Number(item.candidate.end.toFixed(3))
      },
      transition: index === 0 ? 'cut' as const : (item.score > 0.72 ? 'dissolve' as const : 'fade' as const),
      score: Number(item.score.toFixed(3)),
      factors: item.factors,
      reasons: makeReasons(item.candidate, item.factors),
      transcript: item.candidate.transcript,
      visual: item.candidate.visual,
      narration: buildNarration(input.goal, item.candidate, keywords, index)
    }))

  return { segments, selectedIds: segments.map((segment) => segment.id) }
}

function command(item: Omit<PlanCommand, 'id'>, index: number): PlanCommand {
  return { ...item, id: `plan-${index + 1}` }
}

function transform() {
  return { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 }
}

function commandsForSegments(
  segments: StorySegment[],
  input: PlannerInput,
  options: PlannerOptions
): PlanCommand[] {
  const commands: PlanCommand[] = []
  let outputTime = 0
  let captionIndex = 0
  let narrationTime = 0

  for (const segment of segments) {
    const duration = segment.source.end - segment.source.start
    commands.push(command({
      kind: 'clip.add',
      payload: {
        clip: {
          id: `plan-clip-${segment.source.mediaId}-${segment.id}`,
          trackId: options.videoTrackId ?? 'track-video',
          mediaId: segment.source.mediaId,
          sourceStart: segment.source.start,
          timelineStart: Number(outputTime.toFixed(3)),
          duration: Number(duration.toFixed(3)),
          transform: transform(),
          effects: [],
          volume: 1
          ,transitionIn: segment.transition === 'cut' ? 'none' : segment.transition,
          transitionOut: 'none',
          transitionDuration: .5
        }
      }
    }, commands.length))

    for (const speech of input.transcript) {
      const start = Math.max(speech.start, segment.source.start)
      const end = Math.min(speech.end, segment.source.end)
      if (end - start < 0.2 || !speech.text.trim()) continue
      commands.push(command({
        kind: 'clip.add',
        payload: {
          clip: {
            id: `plan-caption-${segment.source.mediaId}-${segment.id}-${++captionIndex}`,
            trackId: options.captionTrackId ?? 'track-caption',
            mediaId: speech.mediaId,
            sourceStart: start,
            timelineStart: Number((outputTime + start - segment.source.start).toFixed(3)),
            duration: Number((end - start).toFixed(3)),
            transform: transform(),
            effects: [],
            text: speech.text.trim(),
            volume: 1
          }
        }
      }, commands.length))
    }

    if (options.narrationTrackId) {
      narrationTime = Math.max(narrationTime, outputTime)
      commands.push(command({
        kind: 'clip.add',
        payload: {
          clip: {
            id: `plan-narration-${segment.id}`,
            trackId: options.narrationTrackId,
            mediaId: `pending-tts:${segment.id}`,
            sourceStart: 0,
            timelineStart: Number(narrationTime.toFixed(3)),
            duration: Number(duration.toFixed(3)),
            transform: transform(),
            effects: [],
            text: segment.narration,
            narration: segment.narration,
            narrationPending: true,
            volume: 1.15
          }
        }
      }, commands.length))
      narrationTime += duration
    }

    outputTime += duration
  }

  return commands
}

export function createNarrativePlan(
  input: PlannerInput,
  options: PlannerOptions = {}
): NarrativePlan {
  const resolvedOptions: PlannerOptions = {
    videoTrackId: options.videoTrackId ?? 'track-video',
    captionTrackId: options.captionTrackId ?? 'track-caption',
    ...(options.narrationTrackId ? { narrationTrackId: options.narrationTrackId } : {}),
    ...(options.strategyId ? { strategyId: options.strategyId } : {}),
    candidateLimit: clampNumber(Math.round(options.candidateLimit ?? 48), 6, 240),
    ...(options.weights ? { weights: options.weights } : {})
  }
  const strategies = planStrategies.map((strategy) => ({
    ...strategy,
    weights: { ...strategy.weights }
  }))
  const strategy = strategies.find((item) => item.id === options.strategyId) ?? strategies[0]!
  const weights = normalizedWeights(strategy.weights, options.weights)
  const allCandidates = candidateWindows(input)
  const candidates = allCandidates
    .map((candidate) => {
      const factors = makeFactors(candidate, weights)
      return { candidate, score: scoreOf(factors) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, resolvedOptions.candidateLimit)
    .map((item) => item.candidate)
    .sort((a, b) => a.start - b.start)
  const selected = selectSegments(input, candidates, weights)

  return {
    goal: input.goal,
    targetSeconds: input.targetSeconds,
    strategyId: strategy.id,
    strategies,
    segments: selected.segments,
    selectedIds: selected.selectedIds,
    selectedDuration: Number(selected.segments.reduce(
      (total, segment) => total + segment.source.end - segment.source.start,
      0
    ).toFixed(3)),
    analysis: {
      sceneCount: input.scenes.length,
      speechCount: input.transcript.length,
      sourceDuration: Number(Math.max(
        0,
        ...[...input.scenes, ...input.transcript].map((item) => item.end)
      ).toFixed(3))
    },
    input,
    options: resolvedOptions,
    weightSummary: {
      normalized: weights,
      overrides: options.weights ?? {}
    },
    candidateCount: allCandidates.length,
    commands: commandsForSegments(
      selected.segments.filter((segment) => selected.selectedIds.includes(segment.id)),
      input,
      resolvedOptions
    )
  }
}

export function createSegmentPlan(
  plan: NarrativePlan,
  selectedIds: string[],
  strategyId?: PlanStrategy['id']
): NarrativePlan {
  const strategy = plan.strategies.find((item) => item.id === (strategyId ?? plan.strategyId)) ?? plan.strategies[0]!
  const weights = plan.weightSummary?.normalized ?? strategy.weights
  const segments = plan.segments.map((segment) => ({
    ...segment,
    selected: selectedIds.includes(segment.id)
  }))
  const chosen = segments.filter((segment) => selectedIds.includes(segment.id))

  return {
    ...plan,
    strategyId: strategy.id,
    selectedIds: [...selectedIds],
    selectedDuration: Number(chosen.reduce(
      (total, segment) => total + segment.source.end - segment.source.start,
      0
    ).toFixed(3)),
    segments,
    weightSummary: plan.weightSummary ?? {
      normalized: strategy.weights,
      overrides: plan.options.weights ?? {}
    },
    candidateCount: plan.candidateCount ?? plan.segments.length,
    commands: commandsForSegments(chosen, plan.input, plan.options)
  }
}
