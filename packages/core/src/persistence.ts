import type { Command, CommandHistoryEntry, Project } from './types'

export interface SavedDocument {
  format: 'ai-video-workstation/1'
  project: Project
  history: Command[]
  future: Command[]
}

export function serializeProject(
  project: Project,
  document: { history: CommandHistoryEntry[]; future: Command[] }
): string {
  const saved: SavedDocument = {
    format: 'ai-video-workstation/1',
    project,
    history: document.history.map((entry) => entry.command),
    future: document.future
  }
  return JSON.stringify(saved, null, 2)
}

export function deserializeProject(raw: string): Omit<SavedDocument, 'history'> & {
  history: CommandHistoryEntry[]
} {
  const parsed = JSON.parse(raw) as SavedDocument
  if (parsed.format !== 'ai-video-workstation/1') {
    throw new Error('Unknown project format')
  }
  if (!parsed.project || typeof parsed.project !== 'object') {
    throw new Error('Invalid project document')
  }
  return {
    ...parsed,
    history: parsed.history.map((command, index) => ({
      id: command.id,
      command,
      inverse: null,
      at: parsed.project?.meta.updatedAt ?? new Date().toISOString()
    }))
  }
}
