import type { Project, TimelineClip } from './types'

export interface ExportPlanEntry {
  id: string
  path: string
  sourceStart: number
  timelineStart: number
  duration: number
  trackId?: string
  transform?: TimelineClip['transform']
  text?: string
  volume?: number
  hasAudio?: boolean | undefined
  muted?: boolean | undefined
  effects?: TimelineClip['effects']
  transitionIn?: TimelineClip['transitionIn']
  transitionOut?: TimelineClip['transitionOut']
}

export interface ExportPlan {
  meta: Project['meta']
  video: ExportPlanEntry[]
  audio: ExportPlanEntry[]
  caption: ExportPlanEntry[]
  music: ExportPlanEntry[]
}

export function clipToPlanEntry(project: Project, clip: TimelineClip): ExportPlanEntry {
  const asset = project.media.find((item) => item.id === clip.mediaId)
  if (!asset) throw new Error(`Export clip references missing media: ${clip.id}`)
  const track = project.timeline.tracks.find((item) => item.id === clip.trackId)
  const entry: ExportPlanEntry = {
    id: clip.id,
    trackId: clip.trackId,
    path: asset.path,
    sourceStart: clip.sourceStart,
    timelineStart: clip.timelineStart,
    duration: clip.duration,
    transform: clip.transform,
    volume: clip.volume
  }

  if (track?.muted) entry.muted = true
  if (clip.transitionIn) entry.transitionIn = clip.transitionIn
  if (clip.transitionOut) entry.transitionOut = clip.transitionOut
  if (clip.effects.length > 0) entry.effects = clip.effects

  if (clip.text !== undefined) entry.text = clip.text
  return entry
}

export function createTimelinePlan(project: Project): ExportPlan {
  const empty: Record<Project['timeline']['tracks'][number]['kind'], ExportPlanEntry[]> = {
    video: [],
    audio: [],
    caption: [],
    music: []
  }

  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      empty[track.kind].push(clipToPlanEntry(project, clip))
    }
  }

  for (const kind of Object.keys(empty) as Array<keyof typeof empty>) {
    empty[kind].sort((a, b) => a.timelineStart - b.timelineStart)
  }

  return {
    meta: project.meta,
    video: empty.video,
    audio: empty.audio,
    caption: empty.caption,
    music: empty.music
  }
}

export function timelineToExportPlan(project: Project): ExportPlan {
  const plan = createTimelinePlan(project)
  const hiddenTrackIds = new Set(
    project.timeline.tracks
      .filter((track) => track.hidden)
      .map((track) => track.id)
  )

  return {
    ...plan,
    video: plan.video.filter((clip) => !hiddenTrackIds.has(clip.trackId ?? '')),
    audio: plan.audio.filter((clip) => !hiddenTrackIds.has(clip.trackId ?? '')),
    music: plan.music.filter((clip) => !hiddenTrackIds.has(clip.trackId ?? ''))
  }
}
