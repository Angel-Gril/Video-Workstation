import { describe, expect, it } from 'vitest'
import {
  applyReframeTransform,
  assetReframeDefaults,
  dynamicFocusReframeConfig,
  faceFocusReframeConfig
} from './index'

const transform = {
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  brightness: 1,
  contrast: 1,
  saturation: 1
}

describe('smart reframe', () => {
  it('adapts a vertical source to a landscape target around the center', () => {
    const defaults = assetReframeDefaults(
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 }
    )
    const { transform: nextTransform } = applyReframeTransform({ transform }, defaults)

    expect(defaults.mode).toBe('auto')
    expect(defaults.source).toEqual({ width: 1080, height: 1920 })
    expect(nextTransform.scale).toBeCloseTo(3.160, 3)
    expect(nextTransform.x).toBe(0)
    expect(nextTransform.y).toBe(0)
    expect(nextTransform.reframe?.mode).toBe('auto')
    expect(nextTransform.reframe?.source).toEqual({ width: 1080, height: 1920 })
  })

  it('keeps face focus mode and shifts the crop toward a detected face', () => {
    const defaults = assetReframeDefaults(
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 }
    )
    const config = faceFocusReframeConfig(defaults, [
      { x: .78, y: .35, width: .12, height: .12 }
    ])
    const { transform: nextTransform } = applyReframeTransform({ transform }, config)

    expect(config.mode).toBe('faceFocus')
    expect(config.focus.x).toBeGreaterThan(defaults.focus.x)
    expect(nextTransform.reframe?.mode).toBe('faceFocus')
    expect(nextTransform.reframe?.focus?.x).toBeGreaterThan(.5)
  })

  it('falls back to center adaptation when no face is available', () => {
    const defaults = assetReframeDefaults(
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 }
    )
    const config = faceFocusReframeConfig(defaults, [])

    expect(config.mode).toBe('auto')
    expect(config.focus).toEqual({ x: .5, y: .5 })
  })

  it('creates a dynamic focus path from per-frame samples', () => {
    const defaults = assetReframeDefaults(
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 }
    )
    const config = dynamicFocusReframeConfig(defaults, [
      [{ x: .2, y: .5, width: .1, height: .1 }],
      [],
      [{ x: .8, y: .4, width: .1, height: .1 }]
    ])

    expect(config.mode).toBe('faceFocus')
    expect(config.dynamic?.points).toHaveLength(2)
    expect(config.dynamic?.points?.[0]?.x).toBeLessThan(config.dynamic?.points?.[1]?.x ?? 0)
  })
})
