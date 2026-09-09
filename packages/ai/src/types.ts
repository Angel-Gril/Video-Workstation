export interface SpeechSegment {
  id: string
  mediaId: string
  start: number
  end: number
  text: string
  language?: string | undefined
  confidence?: number | undefined
}

export interface SceneBoundary {
  mediaId: string
  start: number
  end: number
  score: number
}

export interface VisualSignal {
  mediaId: string
  start: number
  end: number
  brightness: number
  saturation: number
  motion: number
  colorVariance?: number | undefined
  faceCoverage?: number | undefined
  objects: Array<{ name: string; score: number; box?: number[] | undefined }>
  labels?: string[] | undefined
}

export interface CaptionDraft {
  id: string
  mediaId: string
  start: number
  end: number
  text: string
}

export interface StorySegment {
  id: string
  title: string
  summary: string
  selected: boolean
  source: {
    mediaId: string
    start: number
    end: number
  }
  transition: 'cut' | 'dissolve' | 'fade'
  score: number
  factors: PlanFactor[]
  reasons: string[]
  transcript: string
  visual: {
    motion: number
    brightness: number
    saturation: number
    detail?: number | undefined
    labels?: string[] | undefined
  }
  narration?: string | undefined
}

export interface PlanFactor {
  id: 'scene' | 'speech' | 'intent' | 'duration' | 'visual' | 'detail' | 'keyword' | 'audio'
  label: string
  value: number
  weight: number
  detail: string
}

export type PlanStrategyId = 'balanced' | 'visual' | 'speech' | 'mixed'

export interface PlanStrategy {
  id: PlanStrategyId
  label: string
  description: string
  weights: Record<PlanFactor['id'], number>
}

export interface PlanWeights {
  scene?: number | undefined
  speech?: number | undefined
  intent?: number | undefined
  duration?: number | undefined
  visual?: number | undefined
  detail?: number | undefined
  keyword?: number | undefined
  audio?: number | undefined
}

export interface PlannerOptions {
  videoTrackId?: string
  captionTrackId?: string
  narrationTrackId?: string
  strategyId?: PlanStrategy['id']
  candidateLimit?: number | undefined
  weights?: PlanWeights | undefined
}

export interface PlanCommand {
  id: string
  kind:
    | 'clip.add'
    | 'clip.remove'
    | 'clip.trim'
    | 'clip.move'
    | 'media.add'
    | 'track.add'
  payload: Record<string, unknown>
}

export interface PlannerInput {
  goal: 'summary' | 'highlights' | 'tutorial'
  targetSeconds: number
  transcript: SpeechSegment[]
  scenes: SceneBoundary[]
  visualSignals?: VisualSignal[] | undefined
  instruction?: string | undefined
}

export interface NarrativePlan {
  goal: PlannerInput['goal']
  targetSeconds: number
  strategyId: PlanStrategy['id']
  strategies: PlanStrategy[]
  segments: StorySegment[]
  selectedIds: string[]
  selectedDuration: number
  analysis: {
    sceneCount: number
    speechCount: number
    visualSignalCount: number
    sourceDuration: number
  }
  input: PlannerInput
  options: PlannerOptions
  weightSummary: {
    normalized: Record<PlanFactor['id'], number>
    overrides: PlanWeights
  }
  candidateCount: number
  commands: PlanCommand[]
}
