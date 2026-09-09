#!/usr/bin/env node

import { stdin, stdout } from 'node:process'

const API_URL = (process.env.WORKSTATION_API_URL ?? 'http://127.0.0.1:7350').replace(/\/$/, '')
const API_TIMEOUT_MS = Number(process.env.WORKSTATION_MCP_TIMEOUT_MS ?? 120000)
const SERVER_INFO = { name: 'video-workstation', version: '1.0.0' }
const tools = [
  {
    name: 'workstation_execute',
    description: 'Execute timeline commands and return a reversible command batch.',
    inputSchema: {
      type: 'object',
      required: ['commands'],
      properties: {
        project: { type: 'object', description: 'Optional project; omit to use the saved project' },
        commands: { type: 'array', description: 'Command array accepted by the command reducer' },
        label: { type: 'string' },
        save: { type: 'boolean', default: false }
      }
    }
  },
  {
    name: 'workstation_plan',
    description: 'Analyze local media and create an explainable narrative edit plan.',
    inputSchema: {
      type: 'object',
      required: ['mediaPath'],
      properties: {
        mediaPath: { type: 'string' },
        assetId: { type: 'string' },
        goal: { type: 'string', enum: ['summary', 'highlights', 'tutorial'], default: 'summary' },
        targetSeconds: { type: 'number', default: 30 },
        instruction: { type: 'string' },
        strategyId: { type: 'string', enum: ['balanced', 'visual', 'speech'] },
        candidateLimit: { type: 'integer', minimum: 6, maximum: 240 }
      }
    }
  },
  {
    name: 'workstation_apply_plan',
    description: 'Apply a generated plan to the timeline as one reversible command batch.',
    inputSchema: {
      type: 'object',
      required: ['plan'],
      properties: {
        project: { type: 'object' },
        plan: { type: 'object' },
        asset: { type: 'object' },
        label: { type: 'string' },
        save: { type: 'boolean', default: false },
        replaceTracks: { type: 'boolean', default: true }
      }
    }
  },
  {
    name: 'workstation_export',
    description: 'Start an asynchronous MP4 export.',
    inputSchema: {
      type: 'object',
      required: ['output'],
      properties: { project: { type: 'object' }, output: { type: 'string' } }
    }
  },
  {
    name: 'workstation_job',
    description: 'Query an asynchronous workstation job by id.',
    inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } }
  },
  {
    name: 'workstation_probe',
    description: 'Probe a local media file and return duration, streams, and capability metadata.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } }
    }
  },
  {
    name: 'workstation_preview_proxy',
    description: 'Create a browser-compatible MP4 preview proxy while preserving the source for export.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        save: { type: 'boolean', default: false }
      }
    }
  },
  {
    name: 'workstation_saved_project',
    description: 'Load the current saved workstation project document.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'workstation_save_project',
    description: 'Save a workstation project document locally.',
    inputSchema: { type: 'object', required: ['document'], properties: { document: { type: 'object' } } }
  }
]

function message(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function failure(id, code, text) {
  return { jsonrpc: '2.0', id, error: { code, message: text } }
}

async function api(path, body, method = 'POST') {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Workstation API returned invalid JSON (${response.status})`)
  }
  if (!response.ok) throw new Error(value.error ?? `Workstation API request failed (${response.status})`)
  return value
}

async function createPreviewProxy(args) {
  const result = await api('/api/media/preview-proxy', {
    path: args.path,
    save: Boolean(args.save)
  })
  if (!args.save) return result
  return api('/api/project', undefined, 'GET')
}

function callTool(name, args = {}) {
  switch (name) {
    case 'workstation_execute': return api('/api/agent/execute', args)
    case 'workstation_plan': return api('/api/agent/plan', args)
    case 'workstation_apply_plan': return api('/api/agent/apply-plan', args)
    case 'workstation_export': return api('/api/agent/export', args)
    case 'workstation_job': return api(`/api/jobs/${encodeURIComponent(String(args.jobId))}`, undefined, 'GET')
    case 'workstation_probe': return api('/api/media/probe', { path: args.path })
    case 'workstation_preview_proxy': return createPreviewProxy(args)
    case 'workstation_saved_project': return api('/api/project', undefined, 'GET')
    case 'workstation_save_project': return api('/api/project', args.document)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  }
}

async function dispatch(request) {
  const { id, method, params } = request
  try {
    if (method === 'initialize') {
      return message(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      })
    }
    if (method === 'ping') return message(id, {})
    if (method === 'tools/list') return message(id, { tools })
    if (method === 'tools/call') {
      return message(id, toolResult(await callTool(String(params?.name), params?.arguments)))
    }
    if (method.startsWith('notifications/')) return null
    return failure(id, -32601, `Method not found: ${method}`)
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause)
    return id === null || id === undefined ? null : failure(id, -32000, text)
  }
}

async function main() {
  let buffer = ''
  stdin.setEncoding('utf8')
  for await (const chunk of stdin) {
    buffer += chunk
    let boundary = buffer.indexOf('\n')
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      boundary = buffer.indexOf('\n')
      if (!line) continue
      let request
      try {
        request = JSON.parse(line)
      } catch {
        stdout.write(`${JSON.stringify(failure(null, -32700, 'Parse error'))}\n`)
        continue
      }
      const response = await dispatch(request)
      if (response) stdout.write(`${JSON.stringify(response)}\n`)
    }
  }
}

main().catch((cause) => {
  stdout.write(`${JSON.stringify(failure(null, -32603, cause?.message ?? 'Internal error'))}\n`)
})
