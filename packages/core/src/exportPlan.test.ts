import { describe, expect, it } from 'vitest'
import { clipToPlanEntry, timelineToExportPlan, timelineToFCPXML } from './exportPlan'
import type { Project } from './types'

const project: Project = {
  meta: {
    version: 1,
    name: 'Export',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    width: 1920,
    height: 1080,
    frameRate: 30
  },
  media: [{ id: 'media-1', kind: 'video', name: 'sample.mp4', path: 'media/sample.mp4', duration: 10 }],
  timeline: {
    duration: 5,
    tracks: [
      {
        id: 'track-video',
        kind: 'video',
        clips: [{
          id: 'clip-1',
          trackId: 'track-video',
          mediaId: 'media-1',
          sourceStart: 2,
          timelineStart: 0,
          duration: 5,
          transform: { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, brightness: 1, contrast: 1, saturation: 1 },
          effects: [{
            property: 'opacity',
            keyframes: [
              { time: 0, value: 1, easing: 'linear' },
              { time: 1, value: .5, easing: 'linear' }
            ]
          }],
          volume: 1
          ,audioProcessing: { denoise: .35, normalizeLoudness: true, deess: .5 }
        }],
        locked: false,
        muted: true,
        hidden: false
      },
      {
        id: 'track-caption',
        kind: 'caption',
        clips: [{
          id: 'caption-1',
          trackId: 'track-caption',
          mediaId: 'media-1',
          sourceStart: 2,
          timelineStart: 0,
          duration: 2,
          transform: { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, brightness: 1, contrast: 1, saturation: 1 },
          effects: [],
          text: '示例字幕',
          volume: 1
        }],
        locked: false,
        muted: false,
        hidden: false
      }
    ]
  }
}

describe('export plan', () => {
  it('maps clips to renderer entries by track kind', () => {
    const plan = timelineToExportPlan(project)
    expect(plan.video).toHaveLength(1)
    expect(plan.video[0]).toMatchObject({
      path: 'media/sample.mp4',
      sourceStart: 2,
      duration: 5,
      muted: true
    })
    expect(plan.video[0]?.effects?.[0]?.keyframes[0]).toMatchObject({ time: 0, value: 1 })
    expect(plan.video[0]?.audioProcessing).toEqual({ denoise: .35, normalizeLoudness: true, deess: .5 })
    expect(plan.caption[0]).toMatchObject({ text: '示例字幕' })
    expect(plan.music).toEqual([])
  })

  it('rejects clips with missing media', () => {
    const missing = {
      ...project,
      media: []
    }
    expect(() => clipToPlanEntry(missing, project.timeline.tracks[0]!.clips[0]!)).toThrow('missing media')
  })

  it('excludes clips on hidden audio and video tracks from the export plan', () => {
    const hidden = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((track) => ({ ...track, hidden: true }))
      }
    }
    const plan = timelineToExportPlan(hidden)

    expect(plan.video).toEqual([])
    expect(plan.caption).toHaveLength(1)
  })

  it('renders the timeline as FCPXML', () => {
    const xml = timelineToFCPXML(project)
    expect(xml).toContain('<fcpxml version="1.10">')
    expect(xml).toContain('<asset id="asset-1"')
    expect(xml).toContain('offset="0/30s" start="60/30s" duration="150/30s"')
    expect(xml).toContain('示例字幕')
  })
})
