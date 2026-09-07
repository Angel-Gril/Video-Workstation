import type { Easing, EffectKind, Keyframe, KeyframeTrack, TimelineClip } from './types'

const cubic = (t: number): number => t * t * t

export function sampleEasing(value: number, easing: Easing): number {
  switch (easing) {
    case 'easeIn':
      return value * value
    case 'easeOut':
      return 1 - (1 - value) ** 2
    case 'easeInOut':
      return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2
    case 'linear':
      return value
  }
}
