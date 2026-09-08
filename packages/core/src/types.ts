export type TrackKind = 'video' | 'audio' | 'caption' | 'music'

export type EffectKind =
  | 'opacity'
  | 'scale'
  | 'position'
  | 'rotation'
  | 'brightness'
  | 'contrast'
  | 'saturation'

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

export type TransitionKind =
  | 'none'
  | 'fade'
  | 'dissolve'
  | 'wipe-left'
  | 'wipe-right'
  | 'wipe-up'
  | 'wipe-down'
  | 'slide-left'
  | 'slide-right'
  | 'zoom-in'
  | 'blur-in'

export interface Keyframe {
  time: number
  value: number
  easing: Easing
}

export interface KeyframeTrack {
  property: EffectKind
  keyframes: Keyframe[]
}

export interface MediaTransform {
  scale: number
  x: number
  y: number
  rotation: number
  opacity: number
  brightness: number
  contrast: number
  saturation: number
  reframe?: {
    mode?: 'auto' | 'faceFocus' | undefined
    targetAspect?: number | undefined
    scale?: number | undefined
    focus?: { x: number; y: number } | undefined
    source?: { width: number; height: number } | undefined
    dynamic?: {
      points?: Array<{ time: number; x: number; y: number }> | undefined
      smoothing?: number | undefined
    } | undefined
  } | undefined
}

export interface MediaAsset {
  id: string
  kind: TrackKind
  name: string
  path: string
  duration: number
  width?: number | undefined
  height?: number | undefined
  frameRate?: number | undefined
  audioChannels?: number | undefined
  audioSampleRate?: number | undefined
  codec?: string | undefined
  videoStreamIndex?: number | undefined
  audioStreamIndex?: number | undefined
}

export interface TimelineClip {
  id: string
  trackId: string
  mediaId: string
  sourceStart: number
  timelineStart: number
  duration: number
  transform: MediaTransform
  effects: KeyframeTrack[]
  text?: string | undefined
  volume: number
  transitionIn?: TransitionKind | undefined
  transitionOut?: TransitionKind | undefined
  transitionDuration?: number | undefined
  audioProcessing?: {
    denoise?: number | undefined
    normalizeLoudness?: boolean | undefined
    loudnessTarget?: number | undefined
    deess?: number | undefined
  } | undefined
  narration?: string | undefined
  narrationPath?: string | undefined
  narrationPending?: boolean | undefined
  narrationVoice?: string | undefined
  narrationRate?: string | undefined
}

export interface Track {
  id: string
  kind: TrackKind
  clips: TimelineClip[]
  locked: boolean
  muted: boolean
  hidden: boolean
  gain?: number | undefined
  fadeIn?: number | undefined
  fadeOut?: number | undefined
}

export interface Timeline {
  tracks: Track[]
  duration: number
}

export interface ProjectMeta {
  version: 1
  name: string
  createdAt: string
  updatedAt: string
  width: number
  height: number
  frameRate: number
}

export interface NarrationSettings {
  voice?: string | undefined
  rate?: string | undefined
  audioDucking?: {
    enabled?: boolean | undefined
    gain?: number | undefined
    attack?: number | undefined
    release?: number | undefined
  } | undefined
}

export interface Project {
  meta: ProjectMeta
  narrationSettings?: NarrationSettings | undefined
  media: MediaAsset[]
  timeline: Timeline
}

export interface CommandHistoryEntry {
  id: string
  command: Command
  inverse: Command | null
  at: string
}

export interface ProjectDocument {
  project: Project
  history: CommandHistoryEntry[]
  future: Command[]
}

export interface BatchCommandPayload {
  label?: string | undefined
  commands: Command[]
}

export interface Command {
  id: string
  kind:
    | 'project.set'
    | 'command.batch'
    | 'media.add'
    | 'media.remove'
    | 'track.add'
    | 'track.remove'
    | 'clip.add'
    | 'clip.remove'
    | 'clip.trim'
    | 'clip.move'
    | 'clip.split'
    | 'track.replaceClips'
    | 'clip.transform'
    | 'clip.keyframe.set'
    | 'track.reorder'
  payload: Record<string, unknown>
}
