#!/usr/bin/env node
/**
 * Dev-only: turn one DSH session log into replay cases.
 *
 * Each case is a turn's context plus the user message that actually followed
 * it. Tool outputs and attachments are deliberately dropped; only text,
 * tool names/targets, failures, changed files, and open questions survive.
 *
 *   node scripts/export-golden.mjs <session.v4.jsonl.zstd> [out.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { __testing } from '../lib/index.js'

const { assistantText, describeToolCall, shortPath, shortText, buildContext } = __testing

function readEvents(file) {
  const buffer = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === magic[0] && buffer.subarray(index, index + 4).equals(magic)) offsets.push(index)
  }
  const text =
    offsets.length === 0
      ? buffer.toString('utf8')
      : offsets
          .map((offset, index) => {
            const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
            return zlib.zstdDecompressSync(buffer.subarray(offset, end)).toString('utf8')
          })
          .join('')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function trimUser(data) {
  const text = textOf(data?.content)
  if (!text) return null
  return { role: 'user', source: data?.source, content: [{ type: 'text', text }] }
}

function trimAssistant(message) {
  const text = textOf(message?.content)
  if (!text) return null
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function newTracker() {
  return {
    title: '',
    todos: [],
    model: null,
    actions: [],
    changedFiles: [],
    jobs: new Map(),
    lastJob: null,
    goal: null,
    planActive: false,
    deliverables: [],
    cwd: '',
    question: '',
  }
}

function snapshot(tracker) {
  return {
    title: tracker.title,
    todos: tracker.todos.map((todo) => ({ ...todo })),
    model: tracker.model ? { ...tracker.model } : null,
    actions: tracker.actions.map((action) => ({ ...action })),
    changedFiles: [...tracker.changedFiles],
    jobs: [...tracker.jobs.values()].map((job) => ({ ...job })),
    lastJob: tracker.lastJob ? { ...tracker.lastJob } : null,
    goal: tracker.goal,
    planActive: tracker.planActive,
    deliverables: [...tracker.deliverables],
    cwd: tracker.cwd,
    question: tracker.question,
  }
}

function jobFailed(info) {
  const status = String(info?.status || '')
  if (status && status !== 'completed') return true
  const match = String(info?.detail || '').match(/exit code:\s*(-?\d+)/i)
  return match ? Number(match[1]) !== 0 : false
}

function updateStatus(tracker, callId, status, detail) {
  const action = tracker.actions.find((item) => item.callId === callId)
  if (!action) return
  if (status === 'completed' && action.status === 'failed') return
  action.status = status
  if (detail) action.detail = detail
}

function rememberAction(tracker, action) {
  if (!action) return
  tracker.actions.push(action)
  if (tracker.actions.length > 12) tracker.actions.shift()
  if (action.kind === 'edit' && action.target && !tracker.changedFiles.includes(action.target)) {
    tracker.changedFiles.push(action.target)
    if (tracker.changedFiles.length > 8) tracker.changedFiles.shift()
  }
}

function exportCases(file) {
  const events = readEvents(file)
  const tracker = newTracker()
  const messages = []
  const cases = []
  let lastTurn = null
  let sessionId = path.basename(path.dirname(file))

  for (const event of events) {
    const data = event?.data || {}
    switch (event.type) {
      case 'session':
        sessionId = event.id || sessionId
        if (typeof event.cwd === 'string') tracker.cwd = event.cwd
        break
      case 'session/title':
        if (typeof data.title === 'string') tracker.title = data.title
        break
      case 'todo/write':
        if (Array.isArray(data.todos)) tracker.todos = data.todos.slice(0, 20)
        break
      case 'model/selection':
        if (typeof data.provider === 'string' && typeof data.model === 'string') {
          tracker.model = { provider: data.provider, model: data.model }
        }
        break
      case 'turn/start':
        tracker.actions = []
        tracker.changedFiles = []
        tracker.jobs.clear()
        tracker.lastJob = null
        tracker.question = ''
        break
      case 'assistant/message': {
        const text = assistantText(data.message)
        if (text) tracker.question = /[?？]\s*$/u.test(text) ? text.slice(-280) : ''
        const message = trimAssistant(data.message)
        if (message) messages.push(message)
        break
      }
      case 'user/message': {
        const text = textOf(data.content)
        const isDirect = !data.source?.kind || data.source.kind === 'user'
        if (isDirect && lastTurn && text) {
          if (buildContext(lastTurn.messages, lastTurn.tracker)) {
            cases.push({
              id: `${sessionId}-turn-${cases.length + 1}`,
              messages: lastTurn.messages,
              tracker: lastTurn.tracker,
              actual: text,
            })
          }
        }
        const message = trimUser(data)
        if (message) messages.push(message)
        if (isDirect) lastTurn = null
        break
      }
      case 'tool/call': {
        const action = describeToolCall(data)
        if (action) rememberAction(tracker, action)
        break
      }
      case 'tool/result': {
        const callId = data?.message?.toolCallId || data?.callId
        if (callId) updateStatus(tracker, callId, data?.message?.isError ? 'failed' : 'completed')
        if (typeof data?.meta?.cwd === 'string') tracker.cwd = data.meta.cwd
        break
      }
      case 'job/registered':
        if (data.jobId) {
          tracker.jobs.set(data.jobId, { label: shortText(data.label || data.kind || 'job', 100), kind: data.kind })
        }
        break
      case 'job/settled': {
        if (data.jobId) tracker.jobs.delete(data.jobId)
        const failed = jobFailed(data)
        tracker.lastJob = {
          label: shortText(data.label || data.kind || 'job', 120),
          status: failed ? 'failed' : 'completed',
          detail: shortText(data.detail, 60),
        }
        if (data.toolCall?.callId) {
          updateStatus(tracker, data.toolCall.callId, failed ? 'failed' : 'completed', shortText(data.detail, 60))
        }
        break
      }
      case 'goal/change': {
        const operation = String(data.operation || '')
        if (operation === 'complete' || operation === 'clear') tracker.goal = null
        else if (typeof data.goal?.objective === 'string' && data.goal.phase === 'active') tracker.goal = data.goal.objective
        else if (data.goal?.phase && data.goal.phase !== 'active') tracker.goal = null
        break
      }
      case 'plan/mode':
        tracker.planActive = data.active === true || data.mode === 'plan' || data.plan === true
        break
      case 'deliverables/presented':
        tracker.deliverables = (Array.isArray(data.files) ? data.files : [])
          .map((item) => shortPath(typeof item === 'string' ? item : item?.path || ''))
          .filter(Boolean)
          .slice(-5)
        break
      case 'working-directory/change':
        if (typeof (data.cwd || data.path || data.directory) === 'string') {
          tracker.cwd = data.cwd || data.path || data.directory
        }
        break
      case 'turn/end':
        lastTurn = { messages: messages.slice(), tracker: snapshot(tracker) }
        break
      default:
        break
    }
  }
  return cases
}

const input = process.argv[2]
if (!input) {
  console.error('usage: node scripts/export-golden.mjs <session.v4.jsonl.zstd> [out.json]')
  process.exit(1)
}
const cases = exportCases(input)
const output = process.argv[3] || path.join('scripts', 'golden', `${path.basename(path.dirname(input))}.json`)
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify({ source: input, cases }, null, 2)}\n`, 'utf8')
console.log(`exported ${cases.length} case(s) -> ${output}`)
