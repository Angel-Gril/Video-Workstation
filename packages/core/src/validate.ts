import type { MediaAsset, Project, TimelineClip, Track } from './types'

export interface ValidationIssue {
  path: string
  message: string
}

const trackKinds = new Set(['video', 'audio', 'caption', 'music'])
const transitionKinds = new Set([
  'none', 'fade', 'dissolve', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down',
  'slide-left', 'slide-right', 'zoom-in', 'blur-in'
])

export function validateProject(project: Project): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!project.meta || typeof project.meta.name !== 'string') {
    issues.push({ path: 'meta', message: 'Project meta is incomplete' })
  }
  const mediaIds = new Set<string>()
  for (const [index, asset] of project.media.entries()) {
    const path = `media.${index}`
    if (!asset.id) issues.push({ path: `${path}.id`, message: 'Media id is required' })
    if (mediaIds.has(asset.id)) {
      issues.push({ path: `${path}.id`, message: 'Duplicate media id' })
    }
    mediaIds.add(asset.id)
    if (asset.duration < 0) {
      issues.push({ path: `${path}.duration`, message: 'Duration cannot be negative' })
    }
    if (asset.previewPath !== undefined && typeof asset.previewPath !== 'string') {
      issues.push({ path: `${path}.previewPath`, message: 'Preview path must be a string' })
    }
  }

  const trackIds = new Set<string>()
  const clipIds = new Set<string>()
  for (const [trackIndex, track] of project.timeline.tracks.entries()) {
    const trackPath = `timeline.tracks.${trackIndex}`
    if (!track.id) {
      issues.push({ path: `${trackPath}.id`, message: 'Track id is required' })
    }
    if (trackIds.has(track.id)) {
      issues.push({ path: `${trackPath}.id`, message: 'Duplicate track id' })
    }
    trackIds.add(track.id)
    if (!trackKinds.has(track.kind)) {
      issues.push({ path: `${trackPath}.kind`, message: 'Unknown track kind' })
    }
    if (track.gain !== undefined && (!Number.isFinite(track.gain) || track.gain < 0 || track.gain > 2)) {
      issues.push({ path: `${trackPath}.gain`, message: 'Track gain must be between 0 and 2' })
    }
    for (const key of ['fadeIn', 'fadeOut'] as const) {
      const value = track[key]
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 30)) {
        issues.push({ path: `${trackPath}.${key}`, message: 'Track fade must be between 0 and 30 seconds' })
      }
    }
    for (const [clipIndex, clip] of track.clips.entries()) {
      const path = `${trackPath}.clips.${clipIndex}`
      validateClip(clip, clipIds, mediaIds, track, issues, path)
    }
  }
  return issues
}

function validateClip(
  clip: TimelineClip,
  clipIds: Set<string>,
  mediaIds: Set<string>,
  track: Track,
  issues: ValidationIssue[],
  path: string
): void {
  if (clipIds.has(clip.id)) {
    issues.push({ path: `${path}.id`, message: 'Duplicate clip id' })
  }
  clipIds.add(clip.id)
  if (!mediaIds.has(clip.mediaId)) {
    issues.push({ path: `${path}.mediaId`, message: 'Unknown media asset' })
  }
  if (clip.trackId !== track.id) {
    issues.push({ path: `${path}.trackId`, message: 'Clip does not belong to track' })
  }
  if (clip.duration <= 0) {
    issues.push({ path: `${path}.duration`, message: 'Duration must be positive' })
  }
  if (clip.sourceStart < 0) {
    issues.push({ path: `${path}.sourceStart`, message: 'Source start cannot be negative' })
  }
  if (clip.timelineStart < 0) {
    issues.push({ path: `${path}.timelineStart`, message: 'Timeline start cannot be negative' })
  }
  for (const key of ['transitionIn', 'transitionOut'] as const) {
    const value = clip[key]
    if (value !== undefined && !transitionKinds.has(value)) {
      issues.push({ path: `${path}.${key}`, message: 'Unknown transition kind' })
    }
  }
  if (
    clip.transitionDuration !== undefined &&
    (!Number.isFinite(clip.transitionDuration) || clip.transitionDuration < 0 || clip.transitionDuration > 2)
  ) {
    issues.push({
      path: `${path}.transitionDuration`,
      message: 'Transition duration must be between 0 and 2 seconds'
    })
  }
  if (clip.audioProcessing) {
    for (const key of ['denoise', 'deess'] as const) {
      const value = clip.audioProcessing[key]
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
        issues.push({ path: `${path}.audioProcessing.${key}`, message: 'Audio processing amount must be between 0 and 1' })
      }
    }
    const loudnessTarget = clip.audioProcessing.loudnessTarget
    if (loudnessTarget !== undefined && (!Number.isFinite(loudnessTarget) || loudnessTarget < -36 || loudnessTarget > -6)) {
      issues.push({ path: `${path}.audioProcessing.loudnessTarget`, message: 'Loudness target must be between -36 and -6 LUFS' })
    }
  }
  for (const [effectIndex, effect] of clip.effects.entries()) {
    for (const [keyIndex, keyframe] of effect.keyframes.entries()) {
      if (keyframe.time < 0 || keyframe.time > clip.duration + 1e-6) {
        issues.push({
          path: `${path}.effects.${effectIndex}.keyframes.${keyIndex}.time`,
          message: 'Keyframe is outside clip duration'
        })
      }
      if (!Number.isFinite(keyframe.value)) {
        issues.push({
          path: `${path}.effects.${effectIndex}.keyframes.${keyIndex}.value`,
          message: 'Keyframe value must be finite'
        })
      }
    }
  }
}
