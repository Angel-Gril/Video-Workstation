import type { Command, CommandHistoryEntry, Project } from './types'
import { applyCommand, invertCommand } from './reducer'

export interface HistoryState {
  history: CommandHistoryEntry[]
  future: Command[]
}

export function prepareHistory(
  project: Project,
  command: Command,
  state: HistoryState,
  at = new Date().toISOString()
): { project: Project } & HistoryState {
  const inverse = invertCommand(command, project)
  return {
    project: applyCommand(project, command),
    history: [...state.history, { id: command.id, command, inverse, at }],
    future: []
  }
}
