import { describe, expect, it } from 'vitest'
import {
  batchCommand,
  applyCommand,
  findClipsAt,
  prepareCommand,
  projectDuration,
  undo,
  validateProject,
  type Command,
  type MediaAsset,
  type Project,
  type TimelineClip
} from './index'

const media: MediaAsset = {
  id: 'media-1',
  kind: 'video',
  name: 'sample.mp4',
  path: 'media/sample.mp4',
  duration: 30,
  width: 1920,
  height: 1080,
  frameRate: 30
}

const clip: TimelineClip = {
  id: 'clip-1',
  trackId: 'track-1',
  mediaId: 'media-1',
  sourceStart: 2,
  timelineStart: 0,
  duration: 5,
  transform: { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, brightness: 1, contrast: 1, saturation: 1 },
  effects: [],
  volume: 1
}

const project: Project = {
  meta: {
    version: 1,
    name: 'Demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    width: 1920,
    height: 1080,
    frameRate: 30
  },
  media: [media],
  timeline: {
    duration: 5,
    tracks: [{ id: 'track-1', kind: 'video', clips: [clip], locked: false, muted: false, hidden: false }]
  }
}

const command: Command = {
  id: 'cmd-1',
  kind: 'clip.split',
  payload: { clipId: 'clip-1', at: 2 }
}

describe('timeline reducer', () => {
  it('splits a clip and preserves source offset', () => {
    const next = applyCommand(project, command)
    const videoTrack = next.timeline.tracks[0]!
    expect(videoTrack.clips).toHaveLength(2)
    expect(videoTrack.clips[0]).toMatchObject({ sourceStart: 2, duration: 2 })
    expect(videoTrack.clips[1]).toMatchObject({ sourceStart: 4, duration: 3, timelineStart: 2 })
    expect(projectDuration(next)).toBe(5)
  })

  it('undoes a command', () => {
    const applied = prepareCommand(project, command, [], [])
    expect(applied.project.timeline.tracks[0]!.clips).toHaveLength(2)
    const restored = undo(applied.project, applied.history, applied.future)
    expect(restored.project.timeline.tracks[0]!.clips).toEqual(project.timeline.tracks[0]!.clips)
    expect(restored.project.timeline).toEqual(project.timeline)
  })

  it('undoes an entire batch as one history unit', () => {
    const secondClip: TimelineClip = { ...clip, id: 'clip-2', timelineStart: 5 }
    const batch = batchCommand(
      project,
      [
        { id: 'cmd-add-2', kind: 'clip.add', payload: { clip: secondClip } },
        { id: 'cmd-remove-1', kind: 'clip.remove', payload: { clipId: 'clip-1' } }
      ],
      '替换片段'
    )
    const applied = prepareCommand(project, batch, [], [])
    expect(applied.project.timeline.tracks[0]!.clips).toHaveLength(1)
    expect(applied.project.timeline.tracks[0]!.clips[0]!.id).toBe('clip-2')
    const restored = undo(applied.project, applied.history, applied.future)
    expect(restored.project.timeline.tracks[0]!.clips).toEqual(project.timeline.tracks[0]!.clips)
  })

  it('undoes sequential track replacement batch members', () => {
    const firstPatch: TimelineClip = { ...clip, text: '第一段', transitionIn: 'fade' }
    const secondPatch: TimelineClip = { ...firstPatch, transitionDuration: 0.8 }
    const firstReplace: Command = {
      id: 'cmd-replace-1',
      kind: 'track.replaceClips',
      payload: {
        trackId: 'track-1',
        clips: [firstPatch]
      }
    }
    const secondReplace: Command = {
      id: 'cmd-replace-2',
      kind: 'track.replaceClips',
      payload: {
        trackId: 'track-1',
        clips: [secondPatch]
      }
    }
    const batch = batchCommand(project, [firstReplace, secondReplace], '批量更新片段')
    const applied = prepareCommand(project, batch, [], [])

    expect(applied.project.timeline.tracks[0]!.clips[0]).toMatchObject({
      text: '第一段',
      transitionIn: 'fade',
      transitionDuration: 0.8
    })

    const restored = undo(applied.project, applied.history, applied.future)
    expect(restored.project.timeline.tracks[0]!.clips).toEqual(project.timeline.tracks[0]!.clips)
  })

  it('finds overlapping clips at a time point', () => {
    const next = applyCommand(project, command)
    expect(findClipsAt(next, 1)).toHaveLength(1)
    expect(findClipsAt(next, 2)).toHaveLength(1)
  })

  it('validates clip ownership and duration', () => {
    const next = applyCommand(project, command)
    expect(validateProject(next)).toEqual([])
    const secondClip = next.timeline.tracks[0]!.clips[1]!
    const broken = {
      ...next,
      timeline: {
        ...next.timeline,
        tracks: [
          {
            ...next.timeline.tracks[0]!,
            clips: [next.timeline.tracks[0]!.clips[0]!, { ...secondClip, sourceStart: -1 }]
          }
        ]
      }
    }
    expect(validateProject(broken).some((issue) => issue.message.includes('Source'))).toBe(true)
  })
})
