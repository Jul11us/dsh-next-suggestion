import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { apply, __testing } from '../lib/index.js'

const PREDICT = '/dsh-next-suggestion/predict'
const CONFIG = '/dsh-next-suggestion/config'

function fakeSession(messages) {
  return { id: 's1', deriveMessages: () => messages }
}

function makeMessages(extra = '') {
  return [
    {
      role: 'user',
      id: 'u1',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '修一下登录页的样式问题' }],
    },
    {
      role: 'assistant',
      id: 'a1',
      content: [
        {
          type: 'text',
          text: '问题在 `login.css`。\n```css\n.login { color: red }\n```\n要我直接改吗？',
        },
      ],
    },
    {
      role: 'user',
      id: 'u2',
      source: { kind: 'user' },
      content: [
        {
          type: 'text',
          text: `先看下 util 包里谁调用了 formatDate。key 是 sk-abcdefghijklmnopqrstuvwxyz，路径 C:\\Users\\Alice\\proj，附件 data:image/png;base64,${'A'.repeat(300)} ${extra}`,
        },
      ],
    },
    {
      role: 'assistant',
      id: 'a2',
      content: [{ type: 'text', text: 'formatDate 目前在 3 个文件里被调用。你希望我先改哪一个？' }],
    },
  ]
}

function makeCtx(options = {}) {
  const routes = new Map()
  const listeners = new Map()
  const calls = []
  const session = fakeSession(options.messages || makeMessages())
  const providers = options.providers || [
    { id: 'cheap-provider', name: 'Cheap' },
    { id: 'expensive-provider', name: 'Expensive' },
  ]
  const models = options.models || {
    'cheap-provider': [{ id: 'deepseek-v4-flash', name: 'Flash' }],
    'expensive-provider': [{ id: 'claude-opus-5', name: 'Opus' }],
  }
  const reply = options.reply || '{"candidates":["把 util 包里的 formatDate 调用点列出来","先修 login.css 的登录框样式","继续","把这三个失败用例修了","把 util 包里的 formatDate 调用点列出来"]}'

  const ctx = {
    logger: { warn: () => {} },
    on(type, handler) {
      listeners.set(type, handler)
      return () => {}
    },
    inject() {
      return () => {}
    },
    effect(execute) {
      const dispose = execute()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: { requestRejection: () => undefined },
    sessions: { get: (id) => (id === 's1' ? session : undefined) },
    llm: {
      listProviders: () => providers,
      listModels: options.listModels || (async (provider) => models[provider] || []),
      stream(streamOptions) {
        calls.push(streamOptions)
        return options.stream ? options.stream(streamOptions) : defaultStream(reply)
      },
    },
  }
  return {
    ctx,
    routes,
    calls,
    emit(_type, event) {
      listeners.get('session/event')?.(session, event)
    },
  }
}

async function* defaultStream(reply) {
  yield { type: 'text-delta', index: 0, text: reply }
  yield { type: 'usage', usage: { inputTokens: 123, outputTokens: 45 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function makeReq(body, method = 'POST') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { 'content-type': 'application/json' }
  return req
}

function makeRes() {
  const res = new EventEmitter()
  res.writableEnded = false
  res.destroyed = false
  res.statusCode = 0
  res.headers = {}
  res.body = ''
  res.setHeader = (key, value) => {
    res.headers[key] = value
  }
  res.end = (body = '') => {
    res.body = body
    res.writableEnded = true
  }
  return res
}

function seedTurn(h, { end = 13, reason = 'completed' } = {}) {
  h.emit('turn/start', { type: 'turn/start', seq: 10, data: { turn: 1 } })
  h.emit('user/message', { type: 'user/message', seq: 11, data: { source: { kind: 'user' } } })
  h.emit('turn/end', { type: 'turn/end', seq: end, data: { reason: { kind: reason } } })
}

async function predict(h, body = { sessionId: 's1' }) {
  const route = h.routes.get(PREDICT)
  assert.ok(route, 'predict route registered')
  const req = makeReq(body)
  const res = makeRes()
  await route.handler(req, res)
  assert.equal(res.statusCode, 200)
  return JSON.parse(res.body)
}

const baseConfig = {
  enabled: true,
  maxCandidates: 3,
  provider: '',
  model: '',
  timeoutMs: 8000,
  debug: true,
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

async function withDeadline(promise, ms = 2500) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('prediction exceeded test deadline')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('parses, dedupes, drops banned and over-long candidates', async () => {
  const h = makeCtx()
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const data = await predict(h)
  assert.equal(data.candidates.length, 3)
  assert.deepEqual(data.candidates, [
    '把 util 包里的 formatDate 调用点列出来',
    '先修 login.css 的登录框样式',
    '把这三个失败用例修了',
  ])
  assert.equal(data.meta.calls, 1)
  assert.equal(data.meta.inputTokens, 123)
  assert.equal(data.meta.outputTokens, 45)
  assert.equal(h.calls.length, 1)
})

test('never makes a second model call for the same turn', async () => {
  const h = makeCtx()
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const first = await predict(h)
  const second = await predict(h)
  assert.deepEqual(first.candidates, second.candidates)
  assert.equal(h.calls.length, 1)
})

test('sanitizes secrets, usernames, base64 and assistant code before the call', async () => {
  const h = makeCtx()
  apply(h.ctx, baseConfig)
  seedTurn(h)
  await predict(h)
  const sent = JSON.stringify(h.calls[0].messages)
  assert.ok(!sent.includes('sk-abcdefghijklmnopqrstuvwxyz'), 'api key removed')
  assert.ok(!sent.includes('Alice'), 'username removed')
  assert.ok(sent.includes('<user>'), 'username placeholder present')
  assert.ok(!sent.includes('AAAA'), 'base64 removed')
  assert.ok(!sent.includes('.login { color: red }'), 'assistant fenced code removed')
  assert.ok(sent.includes('[code]'), 'code placeholder present')
  assert.equal(h.calls[0].maxTokens, 150)
  assert.ok(h.calls[0].system.includes('30 Chinese characters'))
})

test('respects dismissed candidates', async () => {
  const h = makeCtx()
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const data = await predict(h, { sessionId: 's1', dismissed: ['把 util 包里的 formatDate 调用点列出来'] })
  assert.equal(data.candidates.length, 2)
  assert.ok(!data.candidates.includes('把 util 包里的 formatDate 调用点列出来'))
  assert.equal(data.candidates[0], '先修 login.css 的登录框样式')
})

test('disabled setting makes no model call', async () => {
  const h = makeCtx()
  apply(h.ctx, { ...baseConfig, enabled: false })
  seedTurn(h)
  const data = await predict(h)
  assert.deepEqual(data.candidates, [])
  assert.equal(h.calls.length, 0)
})

test('a new turn start invalidates the finished turn', async () => {
  const h = makeCtx()
  apply(h.ctx, baseConfig)
  seedTurn(h)
  h.emit('turn/start', { type: 'turn/start', seq: 14, data: { turn: 2 } })
  const data = await predict(h)
  assert.deepEqual(data.candidates, [])
  assert.equal(h.calls.length, 0)
})

test('aborted streams produce no candidates', async () => {
  const h = makeCtx({
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"candidates":[' }
      await new Promise((resolve) => setTimeout(resolve, 20))
      throw new Error('aborted')
    },
  })
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const data = await predict(h)
  assert.deepEqual(data.candidates, [])
})

test('thin context (one user turn) produces no candidates', async () => {
  const h = makeCtx({
    messages: [
      { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', id: 'a1', content: [{ type: 'text', text: '你好！有什么可以帮你？' }] },
    ],
  })
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const data = await predict(h)
  assert.deepEqual(data.candidates, [])
  assert.equal(h.calls.length, 0)
})

test('greeting-only conversation produces no candidates', async () => {
  const h = makeCtx({
    messages: [
      { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', id: 'a1', content: [{ type: 'text', text: '你好！' }] },
      { role: 'user', id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] },
      { role: 'assistant', id: 'a2', content: [{ type: 'text', text: '在的。' }] },
    ],
  })
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const data = await predict(h)
  assert.deepEqual(data.candidates, [])
  assert.equal(h.calls.length, 0)
})

test('expensive-only route gets one prediction per session', async () => {
  const h = makeCtx({
    providers: [{ id: 'expensive-provider', name: 'Expensive' }],
    models: { 'expensive-provider': [{ id: 'claude-opus-5', name: 'Opus' }] },
  })
  apply(h.ctx, baseConfig)
  h.emit('model/selection', {
    type: 'model/selection',
    seq: 9,
    data: { provider: 'expensive-provider', model: 'claude-opus-5' },
  })
  seedTurn(h)
  const first = await predict(h)
  assert.equal(first.candidates.length, 3)
  const second = await predict(h, { sessionId: 's1', dismissed: [] })
  // Same turn is cached, so it must not call again.
  assert.equal(h.calls.length, 1)

  h.emit('turn/start', { type: 'turn/start', seq: 20, data: { turn: 2 } })
  h.emit('user/message', { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } })
  h.emit('turn/end', { type: 'turn/end', seq: 22, data: { reason: { kind: 'completed' } } })
  const third = await predict(h)
  assert.deepEqual(third.candidates, [])
  assert.equal(h.calls.length, 1)
})

test('explicit provider and model are used', async () => {
  const h = makeCtx()
  apply(h.ctx, {
    ...baseConfig,
    provider: 'expensive-provider',
    model: 'claude-opus-5',
  })
  seedTurn(h)
  await predict(h)
  assert.equal(h.calls[0].provider, 'expensive-provider')
  assert.equal(h.calls[0].model, 'claude-opus-5')
})

test('provider-only setting never falls back to another provider', async () => {
  const h = makeCtx()
  apply(h.ctx, { ...baseConfig, provider: 'unavailable-provider' })
  h.emit('model/selection', {
    type: 'model/selection',
    data: { provider: 'cheap-provider', model: 'deepseek-v4-flash' },
  })
  seedTurn(h)
  const data = await predict(h)
  assert.deepEqual(data.candidates, [])
  assert.equal(h.calls.length, 0, 'no conversation context crosses the requested provider boundary')
})

test('provider-only setting can select its expensive catalog model once', async () => {
  const h = makeCtx()
  apply(h.ctx, { ...baseConfig, provider: 'expensive-provider' })
  seedTurn(h)
  const first = await predict(h)
  assert.ok(first.candidates.length > 0)
  assert.equal(h.calls[0].provider, 'expensive-provider')
  assert.equal(h.calls[0].model, 'claude-opus-5')
  seedTurn(h, { end: 23 })
  assert.deepEqual((await predict(h)).candidates, [])
  assert.equal(h.calls.length, 1)
})

test('model-only setting resolves the specified model without substituting a cheap model', async () => {
  const h = makeCtx()
  apply(h.ctx, { ...baseConfig, model: 'claude-opus-5' })
  seedTurn(h)
  await predict(h)
  assert.equal(h.calls[0].provider, 'expensive-provider')
  assert.equal(h.calls[0].model, 'claude-opus-5')
  assert.equal(h.calls.length, 1)
})

test('an unavailable model-only setting makes no model call', async () => {
  const h = makeCtx()
  apply(h.ctx, { ...baseConfig, model: 'unavailable-model' })
  seedTurn(h)
  assert.deepEqual((await predict(h)).candidates, [])
  assert.equal(h.calls.length, 0)
})

test('two concurrent requests share one model call', async () => {
  const h = makeCtx()
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const route = h.routes.get(PREDICT)
  const first = route.handler(makeReq({ sessionId: 's1' }), makeRes())
  const second = route.handler(makeReq({ sessionId: 's1' }), makeRes())
  const responses = await Promise.all([first, second])
  assert.equal(h.calls.length, 1)
  assert.equal(responses.length, 2)
})

test('one candidate when maxCandidates is 1', async () => {
  const h = makeCtx()
  apply(h.ctx, { ...baseConfig, maxCandidates: 1 })
  seedTurn(h)
  const data = await predict(h)
  assert.equal(data.candidates.length, 1)
})

test('host timeout returns no candidates and does not hang', async () => {
  const h = makeCtx({
    stream: async function* (streamOptions) {
      yield { type: 'text-delta', index: 0, text: '{"candidates":["把 util 包里的 formatDate 调用点列出来"]}' }
      await new Promise((resolve, reject) => {
        if (streamOptions.signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        streamOptions.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  apply(h.ctx, { ...baseConfig, timeoutMs: 1000 })
  seedTurn(h)
  const started = Date.now()
  const data = await predict(h)
  const elapsed = Date.now() - started
  assert.deepEqual(data.candidates, [])
  assert.ok(elapsed >= 900 && elapsed < 3000, `elapsed ${elapsed}ms`)
})

test('host deadline bounds a stalled model catalog and prevents a late model call', async () => {
  let releaseCatalog
  const catalog = new Promise((resolve) => { releaseCatalog = resolve })
  const h = makeCtx({ listModels: () => catalog })
  apply(h.ctx, { ...baseConfig, timeoutMs: 1000 })
  seedTurn(h)
  const started = Date.now()
  const data = await withDeadline(predict(h))
  assert.deepEqual(data.candidates, [])
  assert.ok(Date.now() - started < 1800)
  releaseCatalog([{ id: 'test-mini' }])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.calls.length, 0, 'catalog completion after cancellation cannot start a model request')
})

test('host deadline bounds a provider that ignores abort without replacing a newer cached result', async () => {
  let streamCalls = 0
  const h = makeCtx({
    stream: async function* () {
      streamCalls += 1
      if (streamCalls === 1) await new Promise((resolve) => setTimeout(resolve, 1500))
      yield { type: 'text-delta', text: '{"candidates":["修复 login.css 的布局"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  apply(h.ctx, { ...baseConfig, timeoutMs: 1000 })
  seedTurn(h)
  const started = Date.now()
  assert.deepEqual((await withDeadline(predict(h))).candidates, [])
  assert.ok(Date.now() - started < 1300, 'HTTP response finishes before the uncooperative stream')
  h.emit('turn/start', { type: 'turn/start', seq: 20 })
  h.emit('user/message', { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } })
  h.emit('turn/end', { type: 'turn/end', seq: 22, data: { reason: { kind: 'completed' } } })
  const newer = await predict(h)
  assert.deepEqual(newer.candidates, ['修复 login.css 的布局'])
  await new Promise((resolve) => setTimeout(resolve, 550))
  assert.deepEqual((await predict(h)).candidates, newer.candidates)
  assert.equal(h.calls.length, 2, 'late work cannot erase the current turn cache')
})

test('a closed browser request cancels the model call', async () => {
  let sawAbort = false
  const h = makeCtx({
    stream: async function* (streamOptions) {
      yield { type: 'text-delta', index: 0, text: '{"candidates":["把 util 包里的 formatDate 调用点列出来"]}' }
      await new Promise((resolve, reject) => {
        if (streamOptions.signal.aborted) {
          sawAbort = true
          reject(new Error('aborted'))
          return
        }
        streamOptions.signal.addEventListener(
          'abort',
          () => {
            sawAbort = true
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
    },
  })
  apply(h.ctx, baseConfig)
  seedTurn(h)
  const route = h.routes.get(PREDICT)
  const res = makeRes()
  const pending = route.handler(makeReq({ sessionId: 's1' }), res)
  setTimeout(() => res.emit('close'), 50)
  const started = Date.now()
  await pending
  assert.ok(sawAbort, 'the model signal was aborted')
  assert.ok(Date.now() - started < 1000)
  assert.deepEqual(JSON.parse(res.body).candidates, [])
})

test('state packet carries concrete actions, failures and the open question', async () => {
  const h = makeCtx({
    reply:
      '{"candidates":["修 login.test.ts 里失败的 3 个用例","先看 login.css 的 diff","在移动端宽度下验证 login.css","跑 npm test 看看还有没有别的失败","继续"]}',
  })
  apply(h.ctx, baseConfig)
  h.emit('turn/start', { type: 'turn/start', seq: 10, data: { turn: 1 } })
  h.emit('user/message', { type: 'user/message', seq: 11, data: { source: { kind: 'user' } } })
  h.emit('assistant/message', {
    type: 'assistant/message',
    seq: 12,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '登录框改好了，但移动端还没验证。要我直接改吗？' }],
      },
    },
  })
  h.emit('tool/call', {
    type: 'tool/call',
    seq: 13,
    data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/login.css' }) },
  })
  h.emit('tool/result', {
    type: 'tool/result',
    seq: 14,
    data: { message: { toolCallId: 'c1', isError: false }, meta: { cwd: 'C:\\proj' } },
  })
  h.emit('tool/call', {
    type: 'tool/call',
    seq: 15,
    data: { turn: 1, step: 1, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) },
  })
  h.emit('job/registered', {
    type: 'job/registered',
    seq: 16,
    data: { jobId: 'j1', label: 'npm test', kind: 'pwsh', toolCall: { callId: 'c2' } },
  })
  h.emit('job/settled', {
    type: 'job/settled',
    seq: 17,
    data: {
      jobId: 'j1',
      label: 'npm test',
      kind: 'pwsh',
      status: 'completed',
      detail: 'exit code: 1',
      toolCall: { callId: 'c2' },
    },
  })
  h.emit('tool/result', {
    type: 'tool/result',
    seq: 18,
    data: { message: { toolCallId: 'c2', isError: false } },
  })
  h.emit('turn/end', { type: 'turn/end', seq: 20, data: { reason: { kind: 'completed' } } })

  const data = await predict(h)
  assert.ok(data.candidates.length >= 1)
  const prompt = h.calls[0].messages[0].content[0].text
  assert.ok(prompt.includes('Recent state:'), 'state section present')
  assert.ok(prompt.includes('edit src/login.css [completed]'), 'edit action present')
  assert.ok(prompt.includes('run npm test [failed]'), 'job failure survives the generic tool result')
  assert.ok(prompt.includes('Changed files: src/login.css'), 'changed file present')
  assert.ok(prompt.includes('The assistant is waiting for an answer to'), 'open question present')
  assert.ok(!data.candidates.includes('继续'), 'banned candidate dropped')
})

test('ranking prefers grounded candidates, demotes repeats and keeps intents diverse', () => {
  const context = {
    entities: ['login.css', 'login.test.ts', 'npm test'],
    actions: [{ kind: 'run', target: 'npm test', status: 'failed' }],
    question: '要我直接改吗？',
    todos: [],
    changedFiles: ['src/login.css'],
    state: [],
  }
  const ranked = __testing.rankCandidates(
    ['继续', '跑 npm test', '先看 login.css 的 diff', '在移动端宽度下验证 login.css', '修 login.test.ts 里失败的 3 个用例'],
    context,
    3,
  )
  assert.equal(ranked.length, 3)
  assert.ok(ranked.includes('先看 login.css 的 diff'))
  assert.ok(ranked.includes('修 login.test.ts 里失败的 3 个用例'))
  assert.ok(!ranked.includes('继续'))
  assert.ok(!ranked[0].includes('npm test'), 'completed action is not the top suggestion')
})

test('five generated candidates are reduced to maxCandidates', async () => {
  const h = makeCtx({
    reply:
      '{"candidates":["修 login.test.ts 里失败的 3 个用例","先看 login.css 的 diff","在移动端宽度下验证 login.css","跑 npm test 看看还有没有别的失败","给我看 login.css 的 diff"]}',
  })
  apply(h.ctx, { ...baseConfig, maxCandidates: 2 })
  seedTurn(h)
  const data = await predict(h)
  assert.equal(data.candidates.length, 2)
})

test('ASCII entity matching respects token boundaries', () => {
  assert.equal(__testing.mentions('把 formatTimestamp 的调用点列出来', 'timestamp'), false)
  assert.equal(__testing.mentions('先看 timestamp.ts 的实现', 'timestamp'), true)
  assert.equal(__testing.mentions('把 formatTimestamp 的调用点列出来', 'formatTimestamp'), true)
})

test('config route reports the sanitized settings', async () => {
  const h = makeCtx()
  apply(h.ctx, { ...baseConfig, enabled: false, maxCandidates: 2, debug: false })
  const route = h.routes.get(CONFIG)
  const res = makeRes()
  route.handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.enabled, false)
  assert.equal(data.maxCandidates, 2)
  assert.equal(data.debug, false)
})

let failed = 0
for (const entry of tests) {
  try {
    await entry.fn()
    console.log(`ok - ${entry.name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${entry.name}`)
    console.error(error)
  }
}
if (failed > 0) {
  console.error(`${failed} test(s) failed`)
  process.exit(1)
}
console.log(`${tests.length} test(s) passed`)
