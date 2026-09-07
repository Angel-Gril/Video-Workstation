import {
  applyCommand,
  projectDuration,
  validateProject,
  type Command,
  type Project
} from './index'

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

async function main(): Promise<void> {
  const raw = await readStdin()
  let input: { project: Project; commands: Command[] }
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error('Expected JSON on stdin: { project, commands }')
  }

  let project = input.project
  for (const command of input.commands) {
    project = applyCommand(project, command)
  }
  const output = {
    project,
    duration: projectDuration(project),
    issues: validateProject(project)
  }
  process.stdout.write(JSON.stringify(output, null, 2))
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
