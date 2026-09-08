import { applyCommand, invertCommand, projectDuration, timelineToExportPlan, validateProject } from '@aivideo/core'
import { createNarrativePlan } from '@aivideo/ai'
import type { Command, Project } from '@aivideo/core'
import type { PlannerInput, PlannerOptions } from '@aivideo/ai'

interface ExecuteRequest {
  project: Project
  commands?: Command[]
  label?: string
}

interface PlanRequest {
  input: PlannerInput
  options?: PlannerOptions
}

interface ExportPlanRequest {
  project: Project
}

function fail(message: string): never {
  process.stderr.write(message)
  process.exit(2)
}

async function readStdin(): Promise<unknown> {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { data += chunk })
  return new Promise((resolve, reject) => {
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function executeProject(request: ExecuteRequest) {
  if (!request?.project || typeof request.project !== 'object') {
    fail('Agent bridge requires { project, commands }')
  }
  if (!Array.isArray(request.commands)) fail('Agent bridge commands must be an array')
  try {
    const states = [request.project]
    for (const command of request.commands) {
      states.push(applyCommand(states[states.length - 1]!, command))
    }
    const inverseCommands = request.commands
      .map((command, index) => invertCommand(command, states[index]!))
      .map((command, index) => ({ command, index }))
      .filter((item): item is { command: Command; index: number } => Boolean(item.command))
      .map((item) => item.command)
      .reverse()
    if (inverseCommands.length !== request.commands.length) {
      fail('Agent command batch cannot be inverted')
    }
    const next = states[states.length - 1]!
    const inverse = {
      id: `agent-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind: 'command.batch' as const,
      payload: { label: request.label || 'Agent edit', commands: inverseCommands }
    }
    return {
      project: next,
      duration: projectDuration(next),
      issues: validateProject(next),
      inverse,
      command: {
        id: `agent-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        kind: 'command.batch',
        payload: { label: request.label || 'Agent edit', commands: request.commands }
      },
      appliedCommandIds: request.commands.map((command) => command.id)
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Agent command execution failed')
  }
}

function createPlan(request: PlanRequest) {
  try {
    return { plan: createNarrativePlan(request.input, request.options) }
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Agent plan failed')
  }
}

function createExportPlan(request: ExportPlanRequest) {
  if (!request?.project || typeof request.project !== 'object') {
    fail('Agent export requires a project')
  }
  try {
    return { plan: timelineToExportPlan(request.project), duration: projectDuration(request.project) }
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Agent export plan failed')
  }
}

async function main() {
  const raw = await readStdin()
  let request: { action?: string } & Partial<ExecuteRequest & PlanRequest>
  try {
    request = JSON.parse(String(raw))
  } catch {
    fail('Agent bridge requires JSON input')
  }
  if (request.action === 'execute') {
    process.stdout.write(JSON.stringify(executeProject(request as ExecuteRequest)))
    return
  }
  if (request.action === 'plan') {
    process.stdout.write(JSON.stringify(createPlan(request as PlanRequest)))
    return
  }
  if (request.action === 'export-plan') {
    process.stdout.write(JSON.stringify(createExportPlan(request as ExportPlanRequest)))
    return
  }
  fail('Unsupported agent bridge action')
}

void main()
