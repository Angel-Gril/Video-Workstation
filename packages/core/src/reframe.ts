import type { MediaAsset, Project, TimelineClip } from './types'

export interface ReframeConfig {
  mode: 'auto' | 'faceFocus'
  targetAspect: number
  scale: number
  focus: { x: number; y: number }
  source?: { width: number; height: number }
}

export interface ReframeFace {
  x: number
  y: number
  width: number
  height: number
}

export function assetReframeDefaults(
  asset: Pick<MediaAsset, 'width' | 'height'>,
  target: Pick<Project['meta'], 'width' | 'height'>
): ReframeConfig {
  const sourceAspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  const targetAspect = target.width / Math.max(1, target.height)
  const safeScale = Math.max(
    1,
    sourceAspect / targetAspect,
    targetAspect / sourceAspect
  )
  return {
    mode: 'auto',
    targetAspect,
    scale: Number(safeScale.toFixed(3)),
    focus: { x: .5, y: .5 },
    source: {
      width: asset.width ?? 1920,
      height: asset.height ?? 1080
    }
  }
}

export function applyReframeTransform(
  clip: Pick<TimelineClip, 'transform'>,
  config: ReframeConfig
): Pick<TimelineClip, 'transform'> {
  const sourceWidth = config.source?.width ??
    clip.transform.reframe?.source?.width ?? 1920
  const sourceHeight = config.source?.height ??
    clip.transform.reframe?.source?.height ?? 1080
  const sourceAspect = sourceWidth / Math.max(1, sourceHeight)
  const targetAspect = config.targetAspect
  const requiredScale = Math.max(
    1,
    sourceAspect / targetAspect,
    targetAspect / sourceAspect
  )
  const safeScale = Math.max(config.scale, requiredScale)
  const normalizedX = clampReframe(config.focus.x, 0, 1)
  const normalizedY = clampReframe(config.focus.y, 0, 1)

  return {
    transform: {
      ...clip.transform,
      scale: Number(safeScale.toFixed(3)),
      x: 0,
      y: 0,
      rotation: 0,
      reframe: {
        mode: config.mode,
        targetAspect,
        scale: Number(safeScale.toFixed(3)),
        focus: { x: normalizedX, y: normalizedY },
        source: { width: sourceWidth, height: sourceHeight }
      }
    }
  }
}

export function faceFocusReframeConfig(
  defaults: ReframeConfig,
  faces: ReframeFace[]
): ReframeConfig {
  if (faces.length === 0) return { ...defaults, mode: 'auto' }
  const left = Math.min(...faces.map((face) => face.x))
  const right = Math.max(...faces.map((face) => face.x + face.width))
  const top = Math.min(...faces.map((face) => face.y))
  const bottom = Math.max(...faces.map((face) => face.y + face.height))
  const width = Math.max(1e-6, right - left)
  const height = Math.max(1e-6, bottom - top)
  const weight = Math.min(.35, Math.max(.12, width * height * .8))
  const faceX = (left + right) / 2
  const faceY = (top + bottom) / 2
  return {
    ...defaults,
    mode: 'faceFocus',
    focus: {
      x: clampReframe(defaults.focus.x * (1 - weight) + faceX * weight, 0, 1),
      y: clampReframe(defaults.focus.y * (1 - weight) + faceY * weight, 0, 1)
    }
  }
}

function clampReframe(value: number, low: number, high: number): number {
  return Number(Math.min(high, Math.max(low, Number.isFinite(value) ? value : low)).toFixed(3))
}
