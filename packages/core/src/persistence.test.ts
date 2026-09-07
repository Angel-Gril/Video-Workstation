import { describe, expect, it } from 'vitest'
import { deserializeProject, serializeProject } from './persistence'
import type { Project } from './types'

const project: Project = {
  meta: {
    version: 1,
    name: 'Saved',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    width: 1920,
    height: 1080,
    frameRate: 30
  },
  media: [],
  timeline: { duration: 0, tracks: [] }
}

describe('persistence', () => {
  it('round-trips a project document', () => {
    const serialized = serializeProject(project, { history: [], future: [] })
    expect(serialized).toContain('"format": "ai-video-workstation/1"')
    const restored = deserializeProject(serialized)
    expect(restored.project).toEqual(project)
  })

  it('round-trips command history entries', () => {
    const command = { id: 'cmd-1', kind: 'clip.trim', payload: { clipId: 'clip-1' } } as const
    const raw = serializeProject(project, {
      history: [{ id: command.id, command, inverse: null, at: '2026-01-01T00:00:00.000Z' }],
      future: [command]
    })
    const restored = deserializeProject(raw)
    expect(restored.history).toHaveLength(1)
    expect(restored.history[0]).toMatchObject({ command, inverse: null })
    expect(restored.history[0]?.command.kind).toBe('clip.trim')
    expect(restored.future).toEqual([command])
  })

  it('rejects unknown project formats', () => {
    expect(() => deserializeProject('{"format":"other"}')).toThrow('Unknown project format')
  })

  it('restores externally saved projects without command arrays', () => {
    const restored = deserializeProject(JSON.stringify({ format: 'ai-video-workstation/1', project }))
    expect(restored.project).toEqual(project)
    expect(restored.history).toEqual([])
    expect(restored.future).toEqual([])
  })
})
