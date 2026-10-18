/**
 * Host half of dsh-next-suggestion.
 *
 * The browser half tells this half that a turn just ended; this half reads the
 * live session log, builds a small, sanitized context, calls the configured
 * provider once, and returns 1-3 candidate drafts. No model call originates in
 * the browser, and nothing derived from a session is persisted.
 */
import Schema from '@deepseek-ai/schemastery'

export const name = 'next-suggestion'

/** Public Host capabilities this plugin needs. */
export const inject = ['webServer', 'connection', 'sessions', 'llm']

/** Settings shown on the plugin's Configure page. All fields are volatile so
 * the settings document can edit them without restarting the composition. */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Show next-instruction candidates above the composer.')
    .volatile(),
  maxCandidates: Schema.number()
    .step(1)
    .min(1)
    .max(3)
    .default(3)
    .description('How many candidates to show (1-3).')
    .volatile(),
  provider: Schema.string()
    .default('')
    .description('Provider route for predictions; empty selects a cheap model automatically.')
    .volatile(),
  model: Schema.string()
    .default('')
    .description('Model id for predictions; empty selects a cheap model automatically.')
    .volatile(),
  timeoutMs: Schema.number()
    .step(100)
    .min(1000)
    .max(15000)
    .default(8000)
    .description('Hard timeout for the Host-side model call, in milliseconds.')
    .volatile(),
  debug: Schema.boolean()
    .default(false)
    .description('Return token and latency details so the strip can show them.')
    .volatile(),
})

const PREFIX = '/dsh-next-suggestion'
const PREDICT_PATH = `${PREFIX}/predict`
const CONFIG_PATH = `${PREFIX}/config`
const MODELS_PATH = `${PREFIX}/models`

const MAX_BODY_BYTES = 32 * 1024
const MAX_CONTEXT_CHARS = 6000
const MAX_USER_CHARS = 700
const MAX_ASSISTANT_CHARS = 360
const MAX_DISMISSED = 20
const CATALOG_TTL_MS = 5 * 60 * 1000
const MAX_TRACKED_SESSIONS = 50

const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi,
]

const GREETING_RE =
  /^(?:hi|hello|hey|yo|你好|您好|嗨|哈喽|在吗|在么|早上好|晚上好|午安|谢谢|thanks|thank you)[\s!！。.?？~～]*$/iu

const BANNED_RE =
  /^(?:继续|好的|好|行|可以|还有别的吗|还有吗|需要帮忙吗|需要我帮忙吗|要不要继续|继续吗|接下来呢|然后呢|continue|ok|okay|sounds good|anything else|need help|what else|go on|proceed|next)[\s.!?！？。]*$/iu

const NON_IMPERATIVE_RE = /^(?:我|你|我们|你们|i\b|you\b|we\b|let(?:'|’)s\b)/iu

const EXPENSIVE_RE = /(?:^|[-_/])(?:pro|opus|max|ultra|reasoner)(?:$|[-_/])|reason|thinking|\bo[134]\b|deepseek-r1|r1-preview/iu
const CHEAP_RE = /(?:^|[-_/])(?:flash|mini|lite|cheap|small|haiku|chat|instant|turbo|air)(?:$|[-_/])|flash|mini|lite|haiku/iu

/** Read one Cordis volatile reference or plain value. */
function readValue(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    const inner = value.get()
    return inner === undefined || inner === null ? fallback : inner
  }
  return value
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Replace data that must not leave the machine in a provider request. */
function sanitize(text, limit = 1200) {
  if (typeof text !== 'string') return ''
  let out = text
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]{200,}/gi, '[base64]')
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '[base64]')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[secret]')
  out = out
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1<user>')
    .replace(/(\/home\/)[^/\s]+/g, '$1<user>')
    .replace(/(\/Users\/)[^/\s]+/g, '$1<user>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (out.length > limit) out = `${out.slice(0, limit).trimEnd()}…`
  return out
}

/** Assistant prose only: fenced code and very long runs never enter the prompt. */
function assistantProse(text) {
  return sanitize(
    text
      .replace(/```[\s\S]*?```/g, ' [code] ')
      .replace(/^\s{0,3}(?:[-*]|\d+\.)\s+/gm, ''),
    MAX_ASSISTANT_CHARS,
  )
}

function messageText(message, assistant) {
  const content = message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    text = parts.join('\n')
  }
  text = text.trim()
  if (!text) return ''
  return assistant ? assistantProse(text) : sanitize(text, MAX_USER_CHARS)
}

function normalizeForCompare(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigrams(text) {
  const out = new Set()
  for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2))
  return out
}

/** Loose "same idea" test used for dismissed and repeated candidates. */
function similar(left, right) {
  const a = normalizeForCompare(left)
  const b = normalizeForCompare(right)
  if (!a || !b) return false
  if (a === b) return true
  const shorter = Math.min(a.length, b.length)
  const longer = Math.max(a.length, b.length)
  if (shorter >= 4 && (a.includes(b) || b.includes(a)) && shorter / longer >= 0.6) return true
  const ba = bigrams(a)
  const bb = bigrams(b)
  if (ba.size === 0 || bb.size === 0) return false
  let shared = 0
  for (const gram of ba) if (bb.has(gram)) shared += 1
  return shared / (ba.size + bb.size - shared) >= 0.68
}

function cjkCount(text) {
  const matches = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)
  return matches ? matches.length : 0
}

function wordCount(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length
}

function candidateFits(text) {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  if (BANNED_RE.test(trimmed)) return false
  const cjk = cjkCount(trimmed)
  if (cjk > 0) return cjk <= 30 && trimmed.length <= 64
  return wordCount(trimmed) <= 15 && trimmed.length <= 120
}

function cleanCandidate(raw) {
  if (typeof raw !== 'string') return null
  let text = raw
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/^(?:[-*•]|\d+[.)、])\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  if (text.endsWith('。')) text = text.slice(0, -1)
  if (!candidateFits(text)) return null
  if (NON_IMPERATIVE_RE.test(text)) return null
  return text
}

/** Pull the first balanced JSON object/array out of a model answer. */
function balancedJson(text, start) {
  const opener = text[start]
  if (opener !== '{' && opener !== '[') return null
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function candidateList(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const list = parsed.candidates ?? parsed.suggestions ?? parsed.items
    if (Array.isArray(list)) return list
  }
  return null
}

function parseCandidates(raw, maxCandidates, lastUser, dismissed) {
  const starts = []
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '{' || char === '[') starts.push(index)
  }
  let list = null
  for (const start of starts) {
    const json = balancedJson(raw, start)
    if (!json) continue
    try {
      const parsed = JSON.parse(json)
      const candidate = candidateList(parsed)
      if (candidate) {
        list = candidate
        break
      }
    } catch {
      /* try the next balanced slice */
    }
  }
  if (!list) return []
  const accepted = []
  for (const item of list) {
    const text = cleanCandidate(item)
    if (!text) continue
    if (lastUser && similar(text, lastUser)) continue
    if (dismissed.some((view) => similar(text, view))) continue
    if (accepted.some((view) => similar(text, view))) continue
    accepted.push(text)
    if (accepted.length >= maxCandidates) break
  }
  return accepted
}

function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function shortText(value, limit = 160) {
  if (typeof value !== 'string') return ''
  return sanitize(value.replace(/\s+/g, ' ').trim(), limit)
}

/** Keep paths short and free of a home-directory username. */
function shortPath(value, limit = 120) {
  if (typeof value !== 'string') return ''
  let path = value.replace(/\\/g, '/').trim()
  path = sanitize(path, limit)
  const parts = path.split('/').filter(Boolean)
  if (parts.length > 3) path = parts.slice(-3).join('/')
  return path
}

function parseToolArgs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Translate one tool call into the short line the model actually needs. */
function describeToolCall(data) {
  const name = String(data?.name || 'tool')
  const args = parseToolArgs(data?.arguments)
  const base = {
    callId: typeof data?.callId === 'string' ? data.callId : '',
    name,
    kind: 'tool',
    target: '',
    status: 'running',
    turn: Number(data?.turn) || 0,
    step: Number(data?.step) || 0,
  }
  if (name === 'pwsh' || name === 'bash' || name === 'terminal') {
    return { ...base, kind: 'run', target: shortText(args.command || args.description || '', 160) }
  }
  if (name === 'edit' || name === 'write' || name === 'str_replace' || name === 'apply_patch') {
    return { ...base, kind: 'edit', target: shortPath(args.file_path || args.path || '') }
  }
  if (name === 'read' || name === 'read_image') {
    return { ...base, kind: 'read', target: shortPath(args.file_path || args.path || '') }
  }
  if (name === 'grep') {
    const where = args.path ? ` in ${shortPath(args.path)}` : ''
    return { ...base, kind: 'inspect', target: shortText(`${args.pattern || ''}${where}`, 120) }
  }
  if (name === 'glob') return { ...base, kind: 'inspect', target: shortText(args.pattern || '', 120) }
  if (name === 'todo_write') return null
  if (name === 'present') {
    const files = Array.isArray(args.files)
      ? args.files.map((file) => (typeof file === 'string' ? file : file?.path)).filter(Boolean).slice(0, 3)
      : []
    return { ...base, kind: 'present', target: files.map((file) => shortPath(file)).join(', ') }
  }
  if (name === 'ask_user_question') {
    const question = Array.isArray(args.questions) ? args.questions[0] : undefined
    return {
      ...base,
      kind: 'ask',
      target: shortText(question?.header || question?.question || '', 120),
      status: 'waiting',
    }
  }
  if (name === 'subagent') return { ...base, kind: 'delegate', target: shortText(args.description || '', 100) }
  if (name === 'web_fetch' || name === 'web_search') {
    return { ...base, kind: 'web', target: shortText(args.url || args.query || '', 120) }
  }
  return {
    ...base,
    kind: name,
    target: shortText(args.file_path || args.path || args.command || args.pattern || args.description || '', 120),
  }
}

function categoryOf(text) {
  const value = String(text).trim()
  if (/^(?:提交|commit|push|发布|release|tag|ship)/iu.test(value)) return 'ship'
  if (/^(?:跑|执行|测试|验证|检查|重跑|run|test|verify|check|lint|build|re-?run)/iu.test(value)) return 'verify'
  if (/^(?:看|查|列|读|解释|分析|对比|diff|grep|inspect|review|explain|list|show|read|open)/iu.test(value)) {
    return 'inspect'
  }
  if (/^(?:修|改|加|删|重构|实现|补|更新|回滚|fix|add|remove|refactor|update|implement|rollback)/iu.test(value)) {
    return 'change'
  }
  if (/^(?:要|选|确认|是否|哪个|choose|confirm|decide)/iu.test(value)) return 'decide'
  if (/测试|跑|执行|验证|检查|test|verify|check|run|build|lint/iu.test(value)) return 'verify'
  if (/提交|commit|push|发布|release|tag/iu.test(value)) return 'ship'
  if (/看|查|列|读|解释|分析|diff|grep|inspect|review/iu.test(value)) return 'inspect'
  if (/修|改|加|删|重构|实现|补|更新|fix|add|remove|refactor|update/iu.test(value)) return 'change'
  return 'other'
}

const ENTITY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'app',
  'are',
  'as',
  'at',
  'backend',
  'be',
  'by',
  'client',
  'code',
  'docs',
  'do',
  'false',
  'file',
  'for',
  'frontend',
  'from',
  'have',
  'if',
  'in',
  'is',
  'it',
  'just',
  'lib',
  'none',
  'null',
  'of',
  'on',
  'or',
  'packages',
  'server',
  'src',
  'test',
  'tests',
  'than',
  'that',
  'the',
  'then',
  'this',
  'to',
  'tool',
  'true',
  'we',
  'will',
  'with',
  'you',
  'your',
])

/** Concrete names the model can ground a candidate in. */
function extractEntities(context) {
  const entities = new Set()
  const add = (value) => {
    if (typeof value !== 'string') return
    const text = value.trim()
    if (text.length < 2 || text.length > 80) return
    if (ENTITY_STOPWORDS.has(text.toLowerCase())) return
    entities.add(text)
    if (entities.size >= 60) return
  }
  const addText = (value) => {
    if (typeof value !== 'string') return
    for (const match of value.matchAll(/`([^`\n]{2,60})`/g)) add(match[1])
    for (const match of value.matchAll(/\b[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,6}\b/g)) add(match[0])
    for (const match of value.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)) add(match[0])
    for (const match of value.matchAll(/[\u3400-\u9fff]{2,8}/g)) add(match[0])
  }

  for (const action of context.actions || []) {
    add(action.target)
    const parts = String(action.target || '').split(/[\\/]/).filter(Boolean)
    add(parts.at(-1))
    for (const token of String(action.target || '').split(/\s+/)) {
      if (token.length >= 2 && token.length <= 40 && !token.startsWith('-')) add(token)
    }
    addText(action.target)
  }
  for (const file of context.changedFiles || []) {
    add(file)
    add(String(file).split(/[\\/]/).filter(Boolean).at(-1))
  }
  for (const todo of context.todos || []) addText(todo.content)
  addText(context.lastUser)
  addText(context.question)
  addText(context.title)
  return [...entities].slice(0, 60)
}

function buildStatePacket(context) {
  const lines = []
  const actions = (context.actions || []).slice(-6)
  if (actions.length > 0) {
    for (const action of actions) {
      const status = action.status && action.status !== 'running' ? ` [${action.status}]` : ''
      lines.push(`- ${action.kind} ${action.target || '(workspace)'}${status}`)
    }
  }
  if (context.changedFiles?.length > 0) {
    lines.push(`Changed files: ${context.changedFiles.slice(0, 5).join(', ')}`)
  }
  if (context.runningJobs?.length > 0) lines.push(`Running jobs: ${context.runningJobs.slice(0, 3).join(', ')}`)
  if (context.lastJob && !(context.actions || []).some((action) => action.kind === 'run')) {
    const detail = context.lastJob.detail ? ` (${context.lastJob.detail})` : ''
    lines.push(`Last job: ${context.lastJob.label}${context.lastJob.status ? ` [${context.lastJob.status}]` : ''}${detail}`)
  }
  if (context.goal) lines.push(`Active goal: ${context.goal}`)
  if (context.planActive) lines.push('Plan mode is active.')
  if (context.deliverables?.length > 0) lines.push(`Presented: ${context.deliverables.slice(0, 3).join(', ')}`)
  if (context.cwd) lines.push(`Working directory: ${context.cwd}`)
  return lines
}

function hasConcreteToken(text) {
  return /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}\b|`[^`]+`|(?:src|lib|test|tests|docs|packages|app|backend|frontend)\/|\b(?:npm|pnpm|yarn|git|pytest|vitest|jest|tsc|eslint|build|lint)\b/iu.test(
    text,
  )
}

const VERB_START_RE =
  /^(?:把|看|查|列|跑|执行|修|改|加|删|写|提交|生成|补|验证|检查|重跑|更新|重构|回滚|对比|解释|分析|确认|选|打开|读|搜|测试|整理|发布|run|check|fix|add|remove|write|update|refactor|review|inspect|list|show|read|grep|commit|push|test|verify|explain|analyze|compare|rollback|generate|open|search|publish|tag|summari[sz]e)\b/iu

const VAGUE_RE =
  /(?:^|[\s，,。])(?:继续|再看看|看看|优化一下|处理一下|改一下|完善一下|调整一下|弄一下|搞一下|继续优化|next|continue|improve it|fix it|look into it)(?:$|[\s，,。])|这个|那个|相关|一些/iu

/** ASCII identifiers match whole tokens; Chinese/path text matches by substring. */
function mentions(text, entity) {
  const haystack = String(text).toLowerCase()
  const needle = String(entity).toLowerCase()
  if (needle.length < 2) return false
  if (/^[\x00-\x7f]+$/.test(needle) && /[a-z0-9_]/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i').test(haystack)
  }
  return haystack.includes(needle)
}

function scoreCandidate(text, context) {
  const value = String(text)
  const lower = value.toLowerCase()
  const category = categoryOf(value)
  const entities = context.entities || []
  const actions = context.actions || []
  let score = 0
  const grounded = entities.some((entity) => mentions(value, entity))
  if (grounded) score += 3
  if (VERB_START_RE.test(value)) score += 1
  if (hasConcreteToken(value)) score += 1

  const lastAction = actions.at(-1)
  if (lastAction) {
    const lastTarget = String(lastAction.target || '').split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase()
    const repeatsTarget = lastTarget && lastTarget.length >= 3 && lower.includes(lastTarget)
    if (repeatsTarget && lastAction.kind === 'edit' && category === 'change') score -= 3
    if (repeatsTarget && lastAction.kind === 'run' && category === 'verify') score -= 3
  }

  // State-aware intent prior: this is where the current situation, not just
  // wording, decides whether "commit", "fix", or "inspect" deserves the top slot.
  const hasFailure = actions.some((action) => action.status === 'failed')
  const hasCompletedRun = actions.some((action) => action.kind === 'run' && action.status === 'completed')
  const hasChanges = (context.changedFiles || []).length > 0
  if (category === 'ship' && hasChanges && hasCompletedRun && !hasFailure) score += 5
  if (category === 'change' && hasFailure) score += 2
  if (category === 'verify' && hasFailure) score += 1
  if (category === 'verify' && hasChanges && !hasCompletedRun) score += 1
  if (category === 'inspect' && (context.runningJobs || []).length > 0) score += 1

  if (context.question) {
    const answersQuestion = entities.some(
      (entity) => mentions(context.question, entity) && mentions(value, entity),
    )
    if (answersQuestion) score += 3
    else if (grounded) score += 1
  }
  if (VAGUE_RE.test(value) && !grounded && !hasConcreteToken(value)) score -= 3
  return score
}

/**
 * Generate more than we show, then keep the best grounded, non-repeating,
 * intent-diverse set. This is the local precision layer over the model.
 */
function rankCandidates(candidates, context, maxCandidates) {
  const seen = []
  const scored = []
  for (const text of candidates) {
    if (seen.some((view) => similar(text, view))) continue
    seen.push(text)
    scored.push({ text, score: scoreCandidate(text, context), category: categoryOf(text) })
  }
  scored.sort((left, right) => right.score - left.score)
  const selected = []
  const categories = new Set()
  for (const item of scored) {
    if (selected.length >= maxCandidates) break
    if (categories.has(item.category)) continue
    selected.push(item)
    categories.add(item.category)
  }
  for (const item of scored) {
    if (selected.length >= maxCandidates) break
    if (selected.some((view) => view.text === item.text)) continue
    selected.push(item)
  }
  return selected.map((item) => item.text)
}

function buildPrompt(context, language) {
  const system = [
    'You predict the next instruction a user will give to a coding agent.',
    'Return JSON only, exactly: {"candidates":["...","..."]}.',
    'Return up to 5 items, most likely first. Each item is one imperative sentence that starts with a verb and names a concrete object from the state or recent turns.',
    'Use exact file, test, command, or function names from the state when possible.',
    'Do not suggest an action that the state marks as already completed.',
    'If the last assistant message asks a question, answer it in the first item.',
    'Keep every item under 30 Chinese characters or 15 English words.',
    'Never output greetings, "continue", "ok", "anything else", "need help", "what else", or a restatement of the user\'s last message.',
    'If the context is too thin, only greetings, or nothing concrete can be inferred, return {"candidates":[]}.',
    'Example: state "edit src/login.css [completed]; run npm test [failed] (exit code: 1)" -> {"candidates":["修 login.test.ts 里失败的 3 个用例","跑 npm test 确认还有没有别的失败","先看 login.test.ts 的断言","在移动端宽度下验证 login.css","给我看 login.css 的 diff"]}.',
    `Write the candidates in ${language}.`,
  ].join('\n')

  const user = [
    `Session title: ${context.title || '(untitled)'}`,
    context.todos.length > 0
      ? `Open todos:\n${context.todos.map((todo) => `- [${todo.status}] ${todo.content}`).join('\n')}`
      : 'Open todos: none',
    context.state?.length > 0 ? `Recent state:\n${context.state.join('\n')}` : '',
    'Recent turns:',
    ...context.turns.map((turn) => `USER: ${turn.user}\nASSISTANT: ${turn.assistant || '(no text)'}`),
    'Last user message:',
    context.lastUser,
    context.question ? `The assistant is waiting for an answer to:\n${context.question}` : '',
    'Now return the JSON object.',
  ]
    .filter(Boolean)
    .join('\n\n')

  return { system, user }
}

function buildContext(messages, tracker) {
  if (!Array.isArray(messages) || messages.length === 0) return null

  const turns = []
  let current = null
  for (const message of messages) {
    if (message?.role === 'user') {
      const source = message.source?.kind
      if (source && source !== 'user') continue
      const text = messageText(message, false)
      if (!text) continue
      current = { user: text, assistant: '' }
      turns.push(current)
    } else if (message?.role === 'assistant' && current) {
      const text = messageText(message, true)
      if (text) current.assistant = current.assistant ? `${current.assistant}\n${text}` : text
    }
  }

  if (turns.length < 2) return null
  let recent = turns.slice(-6)
  const lastUser = recent[recent.length - 1]?.user ?? ''
  if (!lastUser) return null
  if (GREETING_RE.test(lastUser) && recent.every((turn) => GREETING_RE.test(turn.user))) return null

  const todos = Array.isArray(tracker?.todos)
    ? tracker.todos
        .filter((todo) => todo && typeof todo.content === 'string' && todo.status !== 'completed')
        .slice(0, 6)
        .map((todo) => ({ content: sanitize(todo.content, 120), status: String(todo.status || 'pending') }))
    : []

  const lastAssistant = recent[recent.length - 1]?.assistant ?? ''
  const inferredQuestion = /[?？]\s*$/u.test(lastAssistant) ? lastAssistant.slice(-280) : ''
  const actions = Array.isArray(tracker?.actions) ? tracker.actions.slice(-8).map((action) => ({ ...action })) : []
  const changedFiles = Array.isArray(tracker?.changedFiles) ? tracker.changedFiles.slice(-8) : []
  const runningJobs = tracker?.jobs instanceof Map
    ? [...tracker.jobs.values()].slice(-3).map((job) => shortText(job.label || job.kind || 'job', 100))
    : Array.isArray(tracker?.jobs)
      ? tracker.jobs.slice(-3).map((job) => shortText(job?.label || job?.kind || 'job', 100))
      : []
  const lastJob = tracker?.lastJob
    ? {
        label: shortText(tracker.lastJob.label, 120),
        status: String(tracker.lastJob.status || ''),
        detail: shortText(tracker.lastJob.detail, 60),
      }
    : null

  const makeContext = () => {
    const context = {
      title: sanitize(tracker?.title || lastUser.slice(0, 60), 120),
      todos,
      turns: recent,
      lastUser,
      question: assistantProse(tracker?.question || inferredQuestion).slice(-280),
      actions,
      changedFiles,
      runningJobs,
      lastJob,
      goal: tracker?.goal ? sanitize(tracker.goal, 180) : '',
      planActive: tracker?.planActive === true,
      deliverables: Array.isArray(tracker?.deliverables) ? tracker.deliverables.slice(-3) : [],
      cwd: tracker?.cwd ? shortPath(tracker.cwd) : '',
    }
    context.state = buildStatePacket(context)
    context.entities = extractEntities(context)
    return context
  }

  let context = makeContext()
  if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
    recent = recent.slice(-3)
    context = makeContext()
  }
  return context
}

function looksExpensive(modelId) {
  return EXPENSIVE_RE.test(modelId)
}

function looksCheap(modelId) {
  return CHEAP_RE.test(modelId) && !looksExpensive(modelId)
}

function emptyResponse() {
  return { candidates: [] }
}

function jsonResponse(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function methodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isJson(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase()
  return type.startsWith('application/json')
}

function trackersKey(sessionId) {
  return String(sessionId)
}

export function apply(ctx, config) {
  /** Per-session in-memory state. Nothing here is written to disk. */
  const trackers = new Map()
  /** Cheap-model catalog cache (provider and model ids only). */
  let catalogCache = { at: 0, value: null, pending: null }
  /** Optional default-selection service; predictions still work without it. */
  let defaultModel = null

  try {
    ctx.inject(['agentDefaultModel'], (sub) => {
      defaultModel = sub.agentDefaultModel
    })
  } catch {
    defaultModel = null
  }

  const readConfig = () => ({
    enabled: readValue(config.enabled, true) !== false,
    maxCandidates: clampInt(readValue(config.maxCandidates, 3), 1, 3, 3),
    provider: String(readValue(config.provider, '') || '').trim(),
    model: String(readValue(config.model, '') || '').trim(),
    timeoutMs: clampInt(readValue(config.timeoutMs, 8000), 1000, 15000, 8000),
    debug: readValue(config.debug, false) === true,
  })

  const logWarn = (code) => {
    try {
      ctx.logger?.warn?.(`next-suggestion: ${code}`)
    } catch {
      /* logging must never affect a prediction */
    }
  }

  const trackerFor = (sessionId) => {
    const key = trackersKey(sessionId)
    let tracker = trackers.get(key)
    if (tracker === undefined) {
      tracker = {
        lastTurnStart: 0,
        lastTurnEnd: 0,
        lastTurnReason: '',
        lastUserSeq: 0,
        title: '',
        todos: [],
        model: null,
        oneShotUsed: false,
        inflight: null,
        cache: null,
        abort: null,
        actions: [],
        changedFiles: [],
        jobs: new Map(),
        lastJob: null,
        goal: null,
        planActive: false,
        deliverables: [],
        cwd: '',
        question: '',
        callActions: new Map(),
        callJobs: new Map(),
      }
      trackers.set(key, tracker)
      if (trackers.size > MAX_TRACKED_SESSIONS) {
        const oldest = trackers.keys().next().value
        if (oldest !== undefined && oldest !== key) {
          trackers.get(oldest)?.abort?.abort()
          trackers.delete(oldest)
        }
      }
    }
    return tracker
  }

  const abortTracker = (tracker) => {
    try {
      tracker.abort?.abort()
    } catch {
      /* nothing to cancel */
    }
    tracker.abort = null
  }

  const rememberAction = (tracker, action) => {
    if (!action) return
    tracker.actions.push(action)
    if (tracker.actions.length > 12) tracker.actions.shift()
    if (action.callId) tracker.callActions.set(action.callId, action)
    if (action.kind === 'edit' && action.target && !tracker.changedFiles.includes(action.target)) {
      tracker.changedFiles.push(action.target)
      if (tracker.changedFiles.length > 8) tracker.changedFiles.shift()
    }
  }

  const updateActionStatus = (tracker, callId, status, detail) => {
    const action = tracker.callActions.get(callId)
    if (!action) return
    // A job's settled frame arrives before its tool/result; never erase a
    // failure reported by the job with the generic non-error tool result.
    if (status === 'completed' && action.status === 'failed') return
    action.status = status
    if (detail) action.detail = detail
  }

  const jobFailed = (info) => {
    const status = String(info?.status || '')
    if (status && status !== 'completed') return true
    const match = String(info?.detail || '').match(/exit code:\s*(-?\d+)/i)
    return match ? Number(match[1]) !== 0 : false
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId || !event || typeof event !== 'object') return
    const tracker = trackerFor(sessionId)
    switch (event.type) {
      case 'turn/start':
        tracker.lastTurnStart = Number(event.seq) || 0
        tracker.cache = null
        tracker.actions = []
        tracker.changedFiles = []
        tracker.callActions.clear()
        tracker.callJobs.clear()
        tracker.lastJob = null
        tracker.question = ''
        tracker.workspaceChanged = false
        abortTracker(tracker)
        break
      case 'turn/end':
        tracker.lastTurnEnd = Number(event.seq) || 0
        tracker.lastTurnReason = String(event.data?.reason?.kind || '')
        tracker.cache = null
        break
      case 'user/message':
        if (event.data?.source?.kind === 'user') {
          tracker.lastUserSeq = Number(event.seq) || 0
          tracker.cache = null
          tracker.question = ''
          abortTracker(tracker)
        }
        break
      case 'assistant/message': {
        const text = assistantProse(assistantText(event.data?.message))
        if (text) tracker.question = /[?？]\s*$/u.test(text) ? text.slice(-280) : ''
        break
      }
      case 'tool/call': {
        const action = describeToolCall(event.data)
        if (action) rememberAction(tracker, action)
        break
      }
      case 'tool/result': {
        const message = event.data?.message
        const callId = message?.toolCallId || event.data?.callId
        if (callId) updateActionStatus(tracker, callId, message?.isError ? 'failed' : 'completed')
        if (typeof event.data?.meta?.cwd === 'string') tracker.cwd = event.data.meta.cwd
        break
      }
      case 'job/registered': {
        const info = event.data
        if (info?.jobId) {
          tracker.jobs.set(info.jobId, {
            label: shortText(info.label || info.kind || 'job', 100),
            kind: String(info.kind || 'job'),
          })
          const callId = info.toolCall?.callId
          if (callId) tracker.callJobs.set(callId, info.jobId)
        }
        break
      }
      case 'job/settled': {
        const info = event.data
        if (info?.jobId) tracker.jobs.delete(info.jobId)
        const failed = jobFailed(info)
        tracker.lastJob = {
          label: shortText(info?.label || info?.kind || 'job', 120),
          status: failed ? 'failed' : 'completed',
          detail: shortText(info?.detail, 60),
        }
        const callId = info?.toolCall?.callId
        if (callId) updateActionStatus(tracker, callId, failed ? 'failed' : 'completed', shortText(info?.detail, 60))
        break
      }
      case 'workspace/changes':
        tracker.workspaceChanged = true
        break
      case 'goal/change': {
        const operation = String(event.data?.operation || '')
        const goal = event.data?.goal
        if (operation === 'complete' || operation === 'clear') tracker.goal = null
        else if (typeof goal?.objective === 'string' && goal.phase === 'active') tracker.goal = goal.objective
        else if (goal?.phase && goal.phase !== 'active') tracker.goal = null
        break
      }
      case 'plan/mode':
        tracker.planActive =
          event.data?.active === true || event.data?.mode === 'plan' || event.data?.plan === true
        break
      case 'deliverables/presented': {
        const files = Array.isArray(event.data?.files) ? event.data.files : []
        tracker.deliverables = files
          .map((file) => shortPath(typeof file === 'string' ? file : file?.path || ''))
          .filter(Boolean)
          .slice(-5)
        break
      }
      case 'working-directory/change': {
        const cwd = event.data?.cwd || event.data?.path || event.data?.directory
        if (typeof cwd === 'string' && cwd) tracker.cwd = cwd
        break
      }
      case 'session/title':
        if (typeof event.data?.title === 'string') tracker.title = event.data.title
        break
      case 'todo/write':
        if (Array.isArray(event.data?.todos)) tracker.todos = event.data.todos.slice(0, 20)
        break
      case 'model/selection':
        if (typeof event.data?.provider === 'string' && typeof event.data?.model === 'string') {
          tracker.model = { provider: event.data.provider, model: event.data.model }
        }
        break
      default:
        break
    }
  })

  const currentSelection = (tracker) => {
    if (tracker?.model) return tracker.model
    try {
      const selection = defaultModel?.currentSelection?.()
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* optional service */
    }
    return null
  }

  const loadCatalog = async () => {
    const now = Date.now()
    if (catalogCache.value && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
    if (catalogCache.pending) return catalogCache.pending
    catalogCache.pending = (async () => {
      let routes = []
      try {
        routes = ctx.llm.listProviders()
      } catch {
        routes = []
      }
      const providers = (
        await Promise.all(
          routes.map(async (route) => {
            if (!route || typeof route.id !== 'string') return null
            let models = []
            try {
              const listed = await ctx.llm.listModels(route.id)
              models = (Array.isArray(listed) ? listed : [])
                .filter((model) => model && typeof model.id === 'string')
                .map((model) => ({ id: model.id, name: String(model.name || model.id) }))
            } catch {
              models = []
            }
            return { id: route.id, name: String(route.name || route.id), models }
          }),
        )
      ).filter(Boolean)
      providers.sort((left, right) => {
        const rank = (id) => (/deepseek/i.test(id) ? 0 : /anthropic|openai/i.test(id) ? 1 : 2)
        return rank(left.id) - rank(right.id)
      })
      catalogCache = { at: Date.now(), value: providers, pending: null }
      return providers
    })().catch((error) => {
      catalogCache = { at: 0, value: null, pending: null }
      throw error
    })
    return catalogCache.pending
  }

  /**
   * Resolve the provider/model route. User-specified routes always win.
   * Empty settings prefer a cheap catalog model; if only an expensive model is
   * available, this session gets at most one prediction.
   */
  const pickRoute = async (tracker) => {
    const settings = readConfig()
    if (settings.provider && settings.model) {
      return { provider: settings.provider, model: settings.model, explicit: true, cheap: false }
    }
    let providers = []
    try {
      providers = await loadCatalog()
    } catch {
      providers = []
    }
    const selection = currentSelection(tracker)
    const wantedProvider = settings.provider
    const wantedModel = settings.model
    const matchingSelection = selection
      && (!wantedProvider || selection.provider === wantedProvider)
      && (!wantedModel || selection.model === wantedModel)
      ? selection
      : null
    const candidates = []
    for (const provider of providers) {
      if (wantedProvider && provider.id !== wantedProvider) continue
      for (const model of provider.models) {
        if (wantedModel && model.id !== wantedModel) continue
        let score = 0
        if (selection?.provider === provider.id) score += 4
        if (selection?.model === model.id) score += 2
        if (looksCheap(model.id)) score += 6
        if (looksExpensive(model.id)) score -= 20
        candidates.push({ provider: provider.id, model: model.id, score, cheap: looksCheap(model.id) })
      }
    }
    candidates.sort((left, right) => right.score - left.score)
    // A model-only setting still names an explicit model; resolve its provider
    // from the catalog (or matching active selection) without substituting one.
    if (wantedModel) {
      const chosen = candidates[0] || matchingSelection
      return chosen ? { provider: chosen.provider, model: chosen.model, explicit: true, cheap: looksCheap(chosen.model) } : null
    }
    const best = candidates.find((item) => item.score > 0 && !looksExpensive(item.model))
    if (best) return { provider: best.provider, model: best.model, explicit: false, cheap: true }

    if (matchingSelection && !looksExpensive(matchingSelection.model)) {
      return { provider: matchingSelection.provider, model: matchingSelection.model, explicit: false, cheap: false }
    }
    const fallback = candidates.find((item) => !looksExpensive(item.model))
    if (fallback) return { provider: fallback.provider, model: fallback.model, explicit: false, cheap: false }

    const expensive = matchingSelection || candidates[0]
    if (expensive && looksExpensive(expensive.model)) {
      if (tracker.oneShotUsed) return null
      tracker.oneShotUsed = true
      return { provider: expensive.provider, model: expensive.model, explicit: false, cheap: false, oneShot: true }
    }
    return null
  }

  const callModel = async (route, prompt, signal) => {
    const started = Date.now()
    let text = ''
    let usage = null
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
      system: prompt.system,
      maxTokens: 150,
      temperature: 0.4,
      signal,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') text += chunk.text
      } else if (chunk.type === 'usage') {
        usage = chunk.usage ?? null
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind !== 'stop' && kind !== 'max-tokens') {
          return { ok: false, text: '', usage, ms: Date.now() - started }
        }
        break
      }
    }
    return { ok: true, text, usage, ms: Date.now() - started }
  }

  const runPredict = async (sessionId, dismissed, signal) => {
    const settings = readConfig()
    if (!settings.enabled) return emptyResponse()

    const tracker = trackerFor(sessionId)
    const turnEnd = tracker.lastTurnEnd
    if (!turnEnd || turnEnd <= tracker.lastTurnStart || turnEnd <= tracker.lastUserSeq) return emptyResponse()
    if (tracker.lastTurnReason && tracker.lastTurnReason !== 'completed') return emptyResponse()
    if (tracker.cache && tracker.cache.turnEnd === turnEnd) return tracker.cache.response

    let session
    try {
      session = ctx.sessions.get(sessionId)
    } catch {
      session = null
    }
    if (!session) return emptyResponse()

    if (!tracker.cwd && typeof session.header?.cwd === 'string' && session.header.cwd) tracker.cwd = session.header.cwd
    let messages
    try {
      messages = session.deriveMessages()
    } catch {
      messages = null
    }
    const context = buildContext(messages, tracker)
    if (!context) return emptyResponse()

    const route = await pickRoute(tracker)
    if (!route) return emptyResponse()

    // A newer turn may have started while the catalog was loading.
    if (signal?.aborted) return emptyResponse()
    if (tracker.lastTurnEnd !== turnEnd || turnEnd <= tracker.lastTurnStart || turnEnd <= tracker.lastUserSeq) {
      return emptyResponse()
    }

    const language = /[\u3400-\u9fff]/u.test(context.lastUser) ? 'Simplified Chinese' : 'English'
    const prompt = buildPrompt(context, language)

    const controller = new AbortController()
    const onAbort = () => {
      try {
        controller.abort()
      } catch {
        /* already aborted */
      }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    tracker.abort = controller

    let result
    try {
      result = await callModel(route, prompt, controller.signal)
    } catch {
      result = { ok: false, text: '', usage: null, ms: 0 }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (tracker.abort === controller) tracker.abort = null
    }

    if (!result.ok) return emptyResponse()
    if (!result.text.trim()) return emptyResponse()
    if (controller.signal.aborted) return emptyResponse()

    const candidates = parseCandidates(result.text, 5, context.lastUser, dismissed)
    if (candidates.length === 0) return emptyResponse()
    const ranked = rankCandidates(candidates, context, settings.maxCandidates)
    if (ranked.length === 0) return emptyResponse()

    const response = { candidates: ranked }
    if (settings.debug) {
      response.meta = {
        provider: route.provider,
        model: route.model,
        inputTokens: Number(result.usage?.inputTokens) || 0,
        outputTokens: Number(result.usage?.outputTokens) || 0,
        ms: result.ms,
        calls: 1,
        auto: route.explicit ? false : true,
      }
    }
    return response
  }

  /** One in-flight and one cached prediction per (session, turn end). */
  const predict = async (sessionId, dismissed, signal) => {
    const settings = readConfig()
    if (!settings.enabled) return emptyResponse()
    const tracker = trackerFor(sessionId)
    const turnEnd = tracker.lastTurnEnd
    if (!turnEnd) return emptyResponse()
    if (tracker.inflight && tracker.inflight.turnEnd === turnEnd) return tracker.inflight.promise
    if (tracker.cache && tracker.cache.turnEnd === turnEnd) return tracker.cache.response

    let onAbort
    const work = runPredict(sessionId, dismissed, signal)
    // Catalog adapters and providers may ignore cancellation. Race the complete
    // prediction so HTTP requests still finish at the configured deadline.
    const bounded = signal ? Promise.race([
      work,
      new Promise((resolve) => {
        onAbort = () => resolve(emptyResponse())
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    ]) : work
    const promise = bounded
      .catch(() => emptyResponse())
      .then((response) => {
        if (tracker.lastTurnEnd === turnEnd && turnEnd > tracker.lastTurnStart && turnEnd > tracker.lastUserSeq) {
          tracker.cache = { turnEnd, response }
        }
        return response
      })
      .finally(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort)
        if (tracker.inflight?.turnEnd === turnEnd) tracker.inflight = null
      })
    tracker.inflight = { turnEnd, promise }
    return promise
  }

  const rejected = (req, res) => {
    let rejection
    try {
      rejection = ctx.connection.requestRejection(req)
    } catch {
      rejection = 403
    }
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  const predictRoute = {
    kind: 'exact',
    path: PREDICT_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        methodNotAllowed(res, 'POST')
        return
      }
      if (!isJson(req)) {
        jsonResponse(res, 415, emptyResponse())
        return
      }
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object') {
        jsonResponse(res, 400, emptyResponse())
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId || sessionId.length > 200) {
        jsonResponse(res, 400, emptyResponse())
        return
      }
      const dismissed = Array.isArray(body.dismissed)
        ? body.dismissed
            .filter((item) => typeof item === 'string' && item.length <= 120)
            .slice(0, MAX_DISMISSED)
        : []

      const controller = new AbortController()
      const timeout = setTimeout(() => {
        try {
          controller.abort()
        } catch {
          /* already aborted */
        }
      }, readConfig().timeoutMs)
      const onClose = () => {
        if (!res.writableEnded) {
          try {
            controller.abort()
          } catch {
            /* already aborted */
          }
        }
      }
      res.on('close', onClose)
      try {
        const response = await predict(sessionId, dismissed, controller.signal)
        jsonResponse(res, 200, response)
      } catch {
        logWarn('predict-failed')
        jsonResponse(res, 200, emptyResponse())
      } finally {
        clearTimeout(timeout)
        res.off('close', onClose)
      }
    },
  }

  const configRoute = {
    kind: 'exact',
    path: CONFIG_PATH,
    handler: (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      const settings = readConfig()
      jsonResponse(res, 200, {
        enabled: settings.enabled,
        maxCandidates: settings.maxCandidates,
        timeoutMs: settings.timeoutMs,
        debug: settings.debug,
        provider: settings.provider,
        model: settings.model,
      })
    },
  }

  const modelsRoute = {
    kind: 'exact',
    path: MODELS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      try {
        const providers = await loadCatalog()
        jsonResponse(res, 200, { providers })
      } catch {
        jsonResponse(res, 200, { providers: [] })
      }
    },
  }

  ctx.effect(() => ctx.webServer.register(predictRoute), 'next-suggestion: predict route')
  ctx.effect(() => ctx.webServer.register(configRoute), 'next-suggestion: config route')
  ctx.effect(() => ctx.webServer.register(modelsRoute), 'next-suggestion: models route')
  ctx.effect(
    () => () => {
      for (const tracker of trackers.values()) abortTracker(tracker)
      trackers.clear()
    },
    'next-suggestion: cancel in-flight predictions',
  )
}

/**
 * Pure helpers for the dev-only replay evaluator. Cordis ignores this export;
 * it exists so the prompt and ranking under test are the shipped ones.
 */
export const __testing = {
  buildContext,
  buildPrompt,
  parseCandidates,
  rankCandidates,
  sanitize,
  extractEntities,
  assistantText,
  describeToolCall,
  shortPath,
  shortText,
  mentions,
}
