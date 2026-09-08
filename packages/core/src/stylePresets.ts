import type { KeyframeTrack, MediaTransform, TimelineClip } from './types'

export interface ClipStylePreset {
  id: string
  name: string
  transform?: Partial<Omit<MediaTransform, 'reframe'>> | undefined
  effects?: KeyframeTrack[] | undefined
  transitionIn?: TimelineClip['transitionIn'] | undefined
  transitionOut?: TimelineClip['transitionOut'] | undefined
  transitionDuration?: number | undefined
  volume?: number | undefined
  audioProcessing?: NonNullable<TimelineClip['audioProcessing']> | undefined
}

const effectKinds = new Set([
  'opacity', 'scale', 'position', 'rotation', 'brightness', 'contrast', 'saturation'
])
const transitionKinds = new Set([
  'none', 'fade', 'dissolve', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down',
  'slide-left', 'slide-right', 'zoom-in', 'blur-in'
])

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isClipStylePreset(value: unknown): value is ClipStylePreset {
  if (!value || typeof value !== 'object') return false
  const preset = value as ClipStylePreset
  if (typeof preset.id !== 'string' || !preset.id) return false
  if (typeof preset.name !== 'string' || !preset.name.trim()) return false
  if (preset.effects !== undefined) {
    if (!Array.isArray(preset.effects)) return false
    if (!preset.effects.every(track =>
      track &&
      typeof track.property === 'string' &&
      effectKinds.has(track.property) &&
      Array.isArray(track.keyframes) &&
      track.keyframes.every(keyframe =>
        isFiniteNumber(keyframe?.time) &&
        isFiniteNumber(keyframe?.value) &&
        typeof keyframe?.easing === 'string'
      )
    )) return false
  }
  for (const key of ['transitionIn', 'transitionOut'] as const) {
    if (preset[key] !== undefined && !transitionKinds.has(preset[key] as string)) return false
  }
  if (preset.transitionDuration !== undefined &&
    (!isFiniteNumber(preset.transitionDuration) || preset.transitionDuration < 0 || preset.transitionDuration > 2)) return false
  if (preset.volume !== undefined && (!isFiniteNumber(preset.volume) || preset.volume < 0 || preset.volume > 2)) return false
  return true
}

export function clipStylePreset(clip: TimelineClip, id: string, name: string): ClipStylePreset {
  const { reframe, ...transform } = clip.transform
  return {
    id,
    name,
    transform,
    effects: clip.effects.map(track => ({ ...track, keyframes: track.keyframes.map(point => ({ ...point })) })),
    transitionIn: clip.transitionIn ?? 'none',
    transitionOut: clip.transitionOut ?? 'none',
    transitionDuration: clip.transitionDuration ?? .5,
    volume: clip.volume,
    audioProcessing: clip.audioProcessing ? { ...clip.audioProcessing } : undefined
  }
}

export function applyClipStylePreset(
  clip: TimelineClip,
  preset: ClipStylePreset,
  reset = true
): TimelineClip {
  const sourceTransform: MediaTransform = reset
    ? {
        scale: 1, x: 0, y: 0, rotation: 0, opacity: 1,
        brightness: 1, contrast: 1, saturation: 1
      }
    : clip.transform
  const sourceEffects = reset ? [] : clip.effects
  const sourceTransitions = reset
    ? { transitionIn: undefined, transitionOut: undefined, transitionDuration: undefined }
    : clip
  const sourceVolume = reset ? 1 : clip.volume
  const sourceAudio = reset ? undefined : clip.audioProcessing

  return {
    ...clip,
    transform: {
      ...sourceTransform,
      ...preset.transform
    },
    effects: preset.effects
      ? preset.effects.map(track => ({ ...track, keyframes: track.keyframes.map(point => ({ ...point })) }))
      : sourceEffects,
    transitionIn: preset.transitionIn ?? sourceTransitions.transitionIn,
    transitionOut: preset.transitionOut ?? sourceTransitions.transitionOut,
    transitionDuration: preset.transitionDuration ?? sourceTransitions.transitionDuration,
    volume: preset.volume ?? sourceVolume,
    audioProcessing: preset.audioProcessing
      ? { ...preset.audioProcessing }
      : sourceAudio
  }
}
