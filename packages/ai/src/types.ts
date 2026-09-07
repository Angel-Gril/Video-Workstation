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
  objects: Array<{ name: string; score: number }>
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
}

export interface PlanFactor {
  id: 'scene' | 'speech' | 'intent' | 'duration' | 'visual'
  label: string
  value: number
  weight: number
  detail: string
}

export interface PlanStrategy {
  id: 'balanced' | 'visual' | 'speech'
  label: string
  description: string
  weights: Record<PlanFactor['id'], number>
}

export interface PlannerOptions {
  videoTrackId?: string
  captionTrackId?: string
  strategyId?: PlanStrategy['id']
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
    sourceDuration: number
  }
  input: PlannerInput
  options: PlannerOptions
  commands: PlanCommand[]
}
