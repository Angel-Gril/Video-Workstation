import type {
  Command,
  CommandHistoryEntry,
  KeyframeTrack,
  Project,
  Timeline,
  TimelineClip,
  Track
} from './types'
import { setKeyframe, shiftKeyframeTrack } from './keyframes.core'

export class CommandError extends Error {}

function trackOf(project: Project, trackId: string): Track {
  const track = project.timeline.tracks.find((item) => item.id === trackId)
  if (!track) throw new CommandError(`Track not found: ${trackId}`)
  return track
}

function clipOf(project: Project, clipId: string): { clip: TimelineClip; track: Track } {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((item) => item.id === clipId)
    if (clip) return { clip, track }
  }
  throw new CommandError(`Clip not found: ${clipId}`)
}

function replaceTrack(project: Project, next: Track): Project {
  const tracks = project.timeline.tracks.map((track) =>
    track.id === next.id ? next : track
  )
  return withTimeline(project, { ...project.timeline, tracks })
}

function withTimeline(project: Project, timeline: Timeline): Project {
  return { ...project, timeline }
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isCommand(value: unknown): value is Command {
  return typeof value === 'object' && value !== null &&
    'id' in value && 'kind' in value && 'payload' in value
}

function invert(command: Command, before: Project): Command | null {
  switch (command.kind) {
    case 'project.set':
      return { ...command, payload: { project: before } }
    case 'command.batch': {
      const commands = Array.isArray(command.payload.commands) ? command.payload.commands : []
      if (!commands.every(isCommand)) return null
      let current = before
      const inverses: Command[] = []
      for (const item of commands) {
        const inverse = invert(item, current)
        if (!inverse) return null
        inverses.unshift(inverse)
        current = apply(current, item)
      }
      return {
        ...command,
        payload: {
          label: typeof command.payload.label === 'string' ? command.payload.label : undefined,
          commands: inverses
        }
      }
    }
    case 'media.add': {
      const asset = command.payload.asset
      return isMediaAsset(asset)
        ? { ...command, kind: 'media.remove', payload: { mediaId: asset.id } }
        : null
    }
    case 'media.remove': {
      const mediaId = command.payload.mediaId
      const asset = typeof mediaId === 'string'
        ? before.media.find((item) => item.id === mediaId)
        : undefined
      return asset
        ? { ...command, kind: 'media.add', payload: { asset } }
        : null
    }
    case 'track.add': {
      const track = command.payload.track
      return isTrack(track)
        ? { ...command, kind: 'track.remove', payload: { trackId: track.id } }
        : null
    }
    case 'track.remove': {
      const trackId = command.payload.trackId
      const track = typeof trackId === 'string'
        ? before.timeline.tracks.find((item) => item.id === trackId)
        : undefined
      return track
        ? { ...command, kind: 'track.add', payload: { track } }
        : null
    }
    case 'clip.add': {
      const clip = command.payload.clip
      return isClip(clip)
        ? { ...command, kind: 'clip.remove', payload: { clipId: clip.id } }
        : null
    }
    case 'clip.remove': {
      const clipId = command.payload.clipId
      if (typeof clipId !== 'string') return null
      const { clip } = clipOf(before, clipId)
      return { ...command, kind: 'clip.add', payload: { clip } }
    }
    case 'clip.trim': {
      const id = command.payload.clipId
      if (typeof id !== 'string') return null
      const { clip } = clipOf(before, id)
      return {
        ...command,
        payload: {
          clipId: id,
          sourceStart: clip.sourceStart,
          timelineStart: clip.timelineStart,
          duration: clip.duration
        }
      }
    }
    case 'clip.move': {
      const id = command.payload.clipId
      if (typeof id !== 'string') return null
      const { clip } = clipOf(before, id)
      return {
        ...command,
        payload: { clipId: id, trackId: clip.trackId, timelineStart: clip.timelineStart }
      }
    }
    case 'clip.split':
      return {
        ...command,
        kind: 'track.replaceClips',
        payload: {
          trackId: clipOf(before, command.payload.clipId as string).track.id,
          clips: clipOf(before, command.payload.clipId as string).track.clips
        }
      }
    case 'clip.transform': {
      const id = command.payload.clipId
      if (typeof id !== 'string') return null
      const { clip } = clipOf(before, id)
      return { ...command, payload: { clipId: id, transform: clip.transform } }
    }
    case 'clip.keyframe.set': {
      const id = command.payload.clipId
      const property = command.payload.property
      if (typeof id !== 'string' || typeof property !== 'string') return null
      const { clip } = clipOf(before, id)
      const track = clip.effects.find((item) => item.property === property)
      return { ...command, payload: { clipId: id, property, track: track ?? null } }
    }
    case 'track.reorder':
      return {
        ...command,
        payload: {
          trackIds: before.timeline.tracks.map((track) => track.id)
        }
      }
    case 'track.replaceClips': {
      const trackId = command.payload.trackId
      const track = typeof trackId === 'string'
        ? before.timeline.tracks.find((item) => item.id === trackId)
        : undefined
      return track
        ? { ...command, payload: { trackId, clips: track.clips } }
        : null
    }
    default:
      return null
  }
}

function apply(project: Project, command: Command): Project {
  switch (command.kind) {
    case 'project.set': {
      const value = command.payload.project
      if (!isProject(value)) throw new CommandError('Invalid project payload')
      return value
    }
    case 'command.batch': {
      const commands = command.payload.commands
      if (!Array.isArray(commands) || !commands.every(isCommand)) {
        throw new CommandError('Invalid command batch')
      }
      return (commands as Command[]).reduce(apply, project)
    }
    case 'media.add': {
      const asset = command.payload.asset
      if (!isMediaAsset(asset)) throw new CommandError('Invalid media asset')
      return { ...project, media: [...project.media, asset] }
    }
    case 'media.remove': {
      const mediaId = command.payload.mediaId
      if (typeof mediaId !== 'string') throw new CommandError('Invalid media id')
      if (project.timeline.tracks.some((track) =>
        track.clips.some((clip) => clip.mediaId === mediaId)
      )) {
        throw new CommandError('Media asset is still used by timeline')
      }
      return { ...project, media: project.media.filter((asset) => asset.id !== mediaId) }
    }
    case 'track.add': {
      const track = command.payload.track
      if (!isTrack(track)) throw new CommandError('Invalid track')
      if (project.timeline.tracks.some((item) => item.id === track.id)) {
        throw new CommandError('Track id already exists')
      }
      return withTimeline(project, {
        ...project.timeline,
        tracks: [...project.timeline.tracks, track]
      })
    }
    case 'track.remove': {
      const trackId = command.payload.trackId
      if (typeof trackId !== 'string') throw new CommandError('Invalid track id')
      return withTimeline(project, {
        ...project.timeline,
        tracks: project.timeline.tracks.filter((track) => track.id !== trackId)
      })
    }
    case 'clip.add': {
      const clip = command.payload.clip
      if (!isClip(clip)) throw new CommandError('Invalid clip')
      const track = trackOf(project, clip.trackId)
      if (track.clips.some((item) => item.id === clip.id)) {
        throw new CommandError('Clip id already exists')
      }
      if (!project.media.some((asset) => asset.id === clip.mediaId)) {
        throw new CommandError('Media asset not found')
      }
      if (clip.duration <= 0) throw new CommandError('Clip duration must be positive')
      return replaceTrack(project, { ...track, clips: [...track.clips, clip] })
    }
    case 'clip.remove': {
      const clipId = command.payload.clipId
      if (typeof clipId !== 'string') throw new CommandError('Invalid clip id')
      const { track } = clipOf(project, clipId)
      return replaceTrack(project, {
        ...track,
        clips: track.clips.filter((clip) => clip.id !== clipId)
      })
    }
    case 'clip.trim': {
      const clipId = command.payload.clipId
      if (typeof clipId !== 'string') throw new CommandError('Invalid clip id')
      const { clip, track } = clipOf(project, clipId)
      const sourceStart = normalizeNumber(command.payload.sourceStart, clip.sourceStart)
      const timelineStart = normalizeNumber(command.payload.timelineStart, clip.timelineStart)
      const duration = normalizeNumber(command.payload.duration, clip.duration)
      if (sourceStart < 0 || timelineStart < 0 || duration <= 0) {
        throw new CommandError('Invalid trim range')
      }
      const next: TimelineClip = { ...clip, sourceStart, timelineStart, duration }
      return replaceTrack(project, {
        ...track,
        clips: track.clips.map((item) => (item.id === clip.id ? next : item))
      })
    }
    case 'clip.move': {
      const clipId = command.payload.clipId
      if (typeof clipId !== 'string') throw new CommandError('Invalid clip id')
      const targetTrackId = command.payload.trackId
      if (typeof targetTrackId !== 'string') throw new CommandError('Invalid target track')
      const timelineStart = command.payload.timelineStart
      if (typeof timelineStart !== 'number' || timelineStart < 0) {
        throw new CommandError('Invalid timeline position')
      }
      const { clip, track } = clipOf(project, clipId)
      const moved: TimelineClip = { ...clip, trackId: targetTrackId, timelineStart }
      if (track.id === targetTrackId) {
        return replaceTrack(project, {
          ...track,
          clips: track.clips.map((item) => (item.id === clip.id ? moved : item))
        })
      }
      const target = trackOf(project, targetTrackId)
      return withTimeline(project, {
        ...project.timeline,
        tracks: project.timeline.tracks.map((item) => {
          if (item.id === track.id) {
            return { ...item, clips: item.clips.filter((part) => part.id !== clip.id) }
          }
          if (item.id === target.id) return { ...item, clips: [...item.clips, moved] }
          return item
        })
      })
    }
    case 'clip.split': {
      const clipId = command.payload.clipId
      const at = command.payload.at
      if (typeof clipId !== 'string' || typeof at !== 'number') {
        throw new CommandError('Invalid split request')
      }
      const { clip, track } = clipOf(project, clipId)
      const localAt = at - clip.timelineStart
      if (localAt <= 0 || localAt >= clip.duration) {
        throw new CommandError('Split point is outside clip')
      }
      const first: TimelineClip = {
        ...clip,
        duration: localAt,
        effects: clip.effects.map((item) => ({ ...item }))
      }
      const second: TimelineClip = {
        ...clip,
        id: `${clip.id}-b`,
        sourceStart: clip.sourceStart + localAt,
        timelineStart: at,
        duration: clip.duration - localAt,
        effects: clip.effects.map((item) => shiftKeyframeTrack(item, -localAt))
      }
      return replaceTrack(project, {
        ...track,
        clips: track.clips
          .filter((item) => item.id !== clip.id)
          .concat(first, second)
          .sort((a, b) => a.timelineStart - b.timelineStart)
      })
    }
    case 'track.replaceClips': {
      const trackId = command.payload.trackId
      const clips = command.payload.clips
      if (typeof trackId !== 'string' || !Array.isArray(clips) || !clips.every(isClip)) {
        throw new CommandError('Invalid track clips payload')
      }
      const track = trackOf(project, trackId)
      const ids = new Set<string>()
      for (const clip of clips as TimelineClip[]) {
        if (clip.trackId !== trackId) {
          throw new CommandError('Restored clip belongs to another track')
        }
        if (ids.has(clip.id)) throw new CommandError('Duplicate restored clip id')
        ids.add(clip.id)
        if (!project.media.some((asset) => asset.id === clip.mediaId)) {
          throw new CommandError('Restored clip references unknown media')
        }
        if (clip.duration <= 0) throw new CommandError('Restored clip duration must be positive')
      }
      return replaceTrack(project, { ...track, clips: clips as TimelineClip[] })
    }
    case 'clip.transform': {
      const clipId = command.payload.clipId
      if (typeof clipId !== 'string') throw new CommandError('Invalid clip id')
      const transform = command.payload.transform
      if (!isTransform(transform)) throw new CommandError('Invalid transform')
      if (transform.reframe !== undefined && !isTransformReframe(transform.reframe)) {
        throw new CommandError('Invalid reframe')
      }
      const { clip, track } = clipOf(project, clipId)
      return replaceTrack(project, {
        ...track,
        clips: track.clips.map((item) =>
          item.id === clip.id ? { ...item, transform } : item
        )
      })
    }
    case 'clip.keyframe.set': {
      const clipId = command.payload.clipId
      const property = command.payload.property
      const time = command.payload.time
      const value = command.payload.value
      if (
        typeof clipId !== 'string' ||
        typeof property !== 'string' ||
        typeof time !== 'number' ||
        typeof value !== 'number'
      ) {
        throw new CommandError('Invalid keyframe command')
      }
      const { clip, track } = clipOf(project, clipId)
      const existing = clip.effects.find((item) => item.property === property)
      const nextTrack = setKeyframe(
        existing ?? { property: property as KeyframeTrack['property'], keyframes: [] },
        { time, value, easing: 'linear' }
      )
      return replaceTrack(project, {
        ...track,
        clips: track.clips.map((item) =>
          item.id === clip.id
            ? {
                ...item,
                effects: [
                  ...item.effects.filter((part) => part.property !== property),
                  nextTrack
                ]
              }
            : item
        )
      })
    }
    case 'track.reorder': {
      const trackIds = command.payload.trackIds
      if (!Array.isArray(trackIds) || trackIds.some((id) => typeof id !== 'string')) {
        throw new CommandError('Invalid track order')
      }
      const wanted = trackIds as string[]
      const byId = new Map(project.timeline.tracks.map((track) => [track.id, track]))
      if (wanted.length !== byId.size || wanted.some((id) => !byId.has(id))) {
        throw new CommandError('Track order does not match project')
      }
      return withTimeline(project, {
        ...project.timeline,
        tracks: wanted.map((id) => byId.get(id)!)
      })
    }
    default: {
      const exhaustive: never = command.kind
      throw new CommandError(`Unsupported command: ${String(exhaustive)}`)
    }
  }
}

export function applyCommand(project: Project, command: Command): Project {
  return apply(project, command)
}

export function invertCommand(command: Command, project: Project): Command | null {
  return invert(command, project)
}

export function prepareCommand(
  project: Project,
  command: Command,
  history: CommandHistoryEntry[],
  future: Command[],
  at = new Date().toISOString()
): { project: Project; history: CommandHistoryEntry[]; future: Command[] } {
  const inverse = invert(command, project)
  return {
    project: apply(project, command),
    history: [...history, { id: command.id, command, inverse, at }],
    future: []
  }
}

export function batchCommand(
  project: Project,
  commands: Command[],
  label: string
): Command {
  let next = project
  for (const item of commands) next = apply(next, item)
  return {
    id: `cmd-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: 'command.batch',
    payload: { label, commands }
  }
}

export function undo(
  project: Project,
  history: CommandHistoryEntry[],
  future: Command[]
): { project: Project; history: CommandHistoryEntry[]; future: Command[] } {
  const entry = history.at(-1)
  if (!entry) return { project, history, future }
  const restored = entry.inverse ? apply(project, entry.inverse) : project
  return {
    project: restored,
    history: history.slice(0, -1),
    future: entry.inverse ? [...future, entry.inverse] : future
  }
}

export function projectDuration(project: Project): number {
  return Math.max(
    0,
    ...project.timeline.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.timelineStart + clip.duration)
    )
  )
}

export function findClipsAt(project: Project, time: number): TimelineClip[] {
  return project.timeline.tracks.flatMap((track) =>
    track.clips.filter(
      (clip) => time >= clip.timelineStart && time < clip.timelineStart + clip.duration
    )
  )
}

export function isProject(value: unknown): value is Project {
  return (
    typeof value === 'object' && value !== null &&
    'meta' in value && 'media' in value && 'timeline' in value
  )
}

export function isMediaAsset(value: unknown): value is Project['media'][number] {
  return typeof value === 'object' && value !== null &&
    'id' in value && 'path' in value && 'duration' in value
}

export function isTrack(value: unknown): value is Track {
  return typeof value === 'object' && value !== null &&
    'id' in value && 'kind' in value && Array.isArray((value as Track).clips)
}

export function isClip(value: unknown): value is TimelineClip {
  return typeof value === 'object' && value !== null &&
    'id' in value && 'mediaId' in value && 'trackId' in value &&
    'sourceStart' in value && 'timelineStart' in value && 'duration' in value
}

export function isTransform(value: unknown): value is TimelineClip['transform'] {
  return typeof value === 'object' && value !== null &&
    'scale' in value && 'x' in value && 'y' in value &&
    'rotation' in value && 'opacity' in value
}

export function isTransformReframe(value: unknown): value is NonNullable<TimelineClip['transform']['reframe']> {
  if (typeof value !== 'object' || value === null) return false
  const reframe = value as Record<string, unknown>
  if (reframe.mode !== undefined && reframe.mode !== 'auto' && reframe.mode !== 'faceFocus') return false
  const targetAspect = reframe.targetAspect
  if (targetAspect !== undefined && (!Number.isFinite(Number(targetAspect)) || Number(targetAspect) <= 0)) return false
  const scale = reframe.scale
  if (scale !== undefined && (!Number.isFinite(Number(scale)) || Number(scale) <= 0)) return false
  if (reframe.focus !== undefined) {
    const focus = reframe.focus as Record<string, unknown>
    const focusX = Number(focus.x)
    const focusY = Number(focus.y)
    if (!Number.isFinite(focusX) || !Number.isFinite(focusY)) return false
  }
  if (reframe.source !== undefined) {
    const source = reframe.source as Record<string, unknown>
    const sourceWidth = Number(source.width)
    const sourceHeight = Number(source.height)
    if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 ||
      !Number.isFinite(sourceHeight) || sourceHeight <= 0) return false
  }
  if (reframe.dynamic !== undefined) {
    const dynamic = reframe.dynamic as Record<string, unknown>
    const smoothing = Number(dynamic.smoothing)
    if (smoothing !== undefined && (!Number.isFinite(smoothing) || smoothing < 0 || smoothing > 1)) return false
    if (!Array.isArray(dynamic.points)) return false
    for (const point of dynamic.points as unknown[]) {
      if (typeof point !== 'object' || point === null) return false
      const { time, x, y } = point as Record<string, unknown>
      if (!Number.isFinite(Number(time)) || Number(time) < 0 ||
        !Number.isFinite(Number(x)) || Number(x) < 0 || Number(x) > 1 ||
        !Number.isFinite(Number(y)) || Number(y) < 0 || Number(y) > 1) return false
    }
  }
  return true
}
