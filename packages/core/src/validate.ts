import type { MediaAsset, Project, TimelineClip, Track } from './types'

export interface ValidationIssue {
  path: string
  message: string
}

const trackKinds = new Set(['video', 'audio', 'caption', 'music'])

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
