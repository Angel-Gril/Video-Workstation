import { describe, expect, it } from 'vitest'
import { applyClipStylePreset, clipStylePreset, isClipStylePreset } from './stylePresets'
import type { TimelineClip } from './types'

const clip: TimelineClip = {
  id: 'clip-1',
  trackId: 'track-1',
  mediaId: 'media-1',
  sourceStart: 0,
  timelineStart: 0,
  duration: 2,
  transform: { scale: 1.2, x: 8, y: 0, rotation: 0, opacity: 1, brightness: 1, contrast: 1, saturation: 1 },
  effects: [{ property: 'opacity', keyframes: [{ time: 0, value: 0, easing: 'linear' }] }],
  volume: .8,
  transitionIn: 'fade',
  transitionOut: 'none',
  transitionDuration: .8,
  audioProcessing: { denoise: .4, normalizeLoudness: true, loudnessTarget: -14, deess: 0 }
}

describe('clip style presets', () => {
  it('captures and applies an absolute style', () => {
    const preset = clipStylePreset(clip, 'style-1', '柔和开场')
    const target = {
      ...clip,
      id: 'clip-2',
      transform: { ...clip.transform, scale: 1, opacity: .5 },
      effects: [],
      transitionIn: 'none' as const,
      volume: 1
    }
    const next = applyClipStylePreset(target, preset)
    expect(next.transform).toEqual(preset.transform)
    expect(next.effects).toEqual(preset.effects)
    expect(next.transitionIn).toBe('fade')
    expect(next.volume).toBe(.8)
  })

  it('rejects invalid presets', () => {
    expect(isClipStylePreset({ id: '', name: 'x' })).toBe(false)
    expect(isClipStylePreset({ id: 'a', name: 'x', transitionDuration: 5 })).toBe(false)
    expect(isClipStylePreset(clipStylePreset(clip, 'style-1', '柔和开场'))).toBe(true)
  })
})
