import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { apply as applyHost } from '../lib/index.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:65301/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.Event = dom.window.Event
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0)
window.cancelAnimationFrame = (id) => window.clearTimeout(id)

const captured = {}
window.__ModuleLoader__ = {
  load(entry) {
    captured.entry = entry
  },
}
vm.runInThisContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
const client = captured.entry.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

const DICTS = {}
function makeT(language) {
  return (key, params) => {
    const dict = DICTS['next-suggestion']?.[language] || DICTS['next-suggestion']?.en || {}
    let value = dict[key] ?? key
    for (const [name, replacement] of Object.entries(params || {})) {
      value = value.replaceAll(`{${name}}`, String(replacement))
    }
    return value
  }
}

function makeForm(value = {}) {
  const snapshot = {
    status: 'ready',
    value: {
      enabled: true,
      maxCandidates: 3,
      provider: '',
      model: '',
      timeoutMs: 8000,
      debug: false,
      ...value,
    },
    revision: 1,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
    set: async () => true,
    unset: async () => true,
  }
}

// Exercise the real Host HTTP response instead of maintaining a separate mock
// shape that can drift from what the browser actually receives.
function makeHostPrediction() {
  const routes = new Map()
  let onEvent
  let modelCalls = 0
  const session = {
    id: 's1',
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: '修一下登录页样式' },
      { role: 'assistant', content: '样式已修复，发现三个失败用例。' },
      { role: 'user', source: { kind: 'user' }, content: '检查这三个失败用例' },
      { role: 'assistant', content: '失败原因已定位到 login.css，可以修复并提交。' },
    ],
  }
  applyHost({
    on: (_type, handler) => { onEvent = handler },
    inject: () => {},
    effect: (execute) => execute(),
    connection: { requestRejection: () => undefined },
    webServer: { register: (route) => routes.set(route.path, route) },
    sessions: { get: (id) => id === session.id ? session : undefined },
    llm: {
      listProviders: () => [{ id: 'test-provider' }],
      listModels: async () => [{ id: 'test-mini' }],
      stream: async function* () {
        modelCalls += 1
        yield { type: 'text-delta', text: JSON.stringify({ candidates: ['把这三个失败用例修了', '提交刚才的改动并写 commit'] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }, { enabled: true, maxCandidates: 3, timeoutMs: 8000 })
  onEvent(session, { type: 'turn/start', seq: 10 })
  onEvent(session, { type: 'user/message', seq: 11, data: { source: { kind: 'user' } } })
  onEvent(session, { type: 'turn/end', seq: 12, data: { reason: { kind: 'completed' } } })
  return {
    modelCalls: () => modelCalls,
    async request(body) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))])
      req.method = 'POST'
      req.headers = { 'content-type': 'application/json' }
      const res = new EventEmitter()
      res.setHeader = () => {}
      res.end = (text) => { res.body = text; res.writableEnded = true }
      await routes.get('/dsh-next-suggestion/predict').handler(req, res)
      assert.equal(res.statusCode, 200)
      const data = JSON.parse(res.body)
      assert.equal(typeof data.candidates[0], 'string', 'Host sends candidate strings')
      return data
    },
  }
}

function setup(componentName, extra = {}) {
  const registrations = []
  const ctx = {
    locale: {
      bind: (ns) => makeT('zh'),
      register: (ns, dict) => {
        DICTS[ns] = dict
        return () => {}
      },
    },
    configForms: { get: () => makeForm(extra.value) },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    conversation: { input: { shell: () => ({ focus() {} }) } },
    effect: (callback) => {
      callback()
      return () => {}
    },
    get: () => undefined,
  }
  client.apply(ctx)
  const registration = registrations.find((entry) => entry.spec.name === componentName)
  assert.ok(registration, `${componentName} registration`)
  return registration
}

function mount(component, props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async (next) => {
    await act(async () => {
      root.render(React.createElement(component, { ...props, ...next }))
    })
  }
  return { container, root, render }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

test('apply registers dock, settings page and dictionaries', async () => {
  assert.ok(client.inject.includes('slots'))
  assert.ok(client.inject.includes('configForms'))
  assert.ok(client.inject.includes('conversation'))
  const dock = setup('conversation.input.dock')
  assert.equal(dock.spec.id, 'next-suggestion')
  assert.equal(dock.spec.order, 15)
  assert.equal(typeof dock.component, 'function')

  const settings = setup('settings.section')
  assert.equal(settings.spec.id, 'next-suggestion')
  assert.equal(typeof settings.component, 'function')

  const bundleConfig = setup('plugins.bundle.config')
  assert.equal(bundleConfig.spec.key, 'dsh-next-suggestion')
  assert.equal(typeof bundleConfig.component, 'function')

  assert.ok(DICTS['next-suggestion'].en)
  assert.ok(DICTS['next-suggestion'].zh)
  assert.equal(DICTS['next-suggestion'].zh['dock.dismiss'], '这次不用')
})

test('settings page stages and saves the config fields', async () => {
  const settings = setup('settings.section')
  const mutations = []
  const form = {
    ...makeForm({ debug: true }),
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      return true
    },
  }
  const view = mount(settings.component, { form, t: makeT('zh') })
  await view.render({})
  await act(async () => {
    await wait(20)
  })
  assert.match(view.container.querySelector('.dns-settings-title').textContent, /下一条指令预测/)
  const switches = view.container.querySelectorAll('.dns-switch')
  assert.ok(switches.length >= 2)
  await act(async () => {
    switches[0].click()
  })
  const save = view.container.querySelector('.dns-button-primary')
  assert.ok(save)
  await act(async () => {
    save.click()
    await wait(20)
  })
  assert.equal(mutations.length, 1)
  assert.deepEqual(mutations[0].ops, [{ op: 'set', path: ['enabled'], value: false }])
  await act(async () => {
    view.root.unmount()
  })
})

test('shows candidates after a turn ends, then fills the draft without sending', async () => {
  const dock = setup('conversation.input.dock')
  const host = makeHostPrediction()
  const calls = []
  const focused = []
  const draftWrites = []
  const props = {
    session: { sessionId: 's1', running: true, blank: false, pendingInteraction: null },
    input: { draft: '' },
    inputActions: {
      setDraft: (text) => draftWrites.push(text),
      submit: () => calls.push('submit'),
    },
    t: makeT('zh'),
    form: makeForm(),
    requestPrediction: (body) => host.request(body),
    focusComposer: (sessionId) => focused.push(sessionId),
  }
  const view = mount(dock.component, props)
  await view.render({})
  assert.equal(view.container.querySelector('.dns-strip'), null)

  await view.render({ session: { ...props.session, running: false } })
  await act(async () => {
    await wait(30)
  })
  const strip = view.container.querySelector('.dns-strip')
  assert.ok(strip, 'strip appears')
  const chips = view.container.querySelectorAll('.dns-chip-text')
  assert.equal(chips.length, 2)
  assert.equal(host.modelCalls(), 1, 'one real Host prediction supplies the dock')

  await act(async () => {
    chips[0].click()
    await wait(10)
  })
  assert.deepEqual(draftWrites, ['把这三个失败用例修了'])
  assert.equal(calls.length, 0, 'never submits')
  assert.deepEqual(focused, ['s1'])
  assert.equal(view.container.querySelector('.dns-strip'), null, 'hides after click')
  await act(async () => {
    view.root.unmount()
  })
})

test('hides while typing and when the slash menu is open', async () => {
  const dock = setup('conversation.input.dock')
  const props = {
    session: { sessionId: 's2', running: true, blank: false, pendingInteraction: null },
    input: { draft: '' },
    inputActions: { setDraft: () => {} },
    t: makeT('zh'),
    form: makeForm(),
    requestPrediction: async () => ({ candidates: [{ text: '看下 util 包里谁调用了 formatDate' }] }),
    focusComposer: () => {},
  }
  const view = mount(dock.component, props)
  await view.render({})
  await view.render({ session: { ...props.session, running: false } })
  await act(async () => {
    await wait(30)
  })
  assert.ok(view.container.querySelector('.dns-strip'))

  await view.render({ session: { ...props.session, running: false }, input: { draft: '把' } })
  assert.equal(view.container.querySelector('.dns-strip'), null, 'typing hides')
  await act(async () => {
    view.root.unmount()
  })
})

test('Escape closes the strip without sending', async () => {
  const dock = setup('conversation.input.dock')
  const props = {
    session: { sessionId: 's3', running: true, blank: false, pendingInteraction: null },
    input: { draft: '' },
    inputActions: { setDraft: () => {}, submit: () => assert.fail('must not submit') },
    t: makeT('zh'),
    form: makeForm(),
    requestPrediction: async () => ({ candidates: [{ text: '把 login.css 的登录框样式修了' }] }),
    focusComposer: () => {},
  }
  const view = mount(dock.component, props)
  await view.render({})
  await view.render({ session: { ...props.session, running: false } })
  await act(async () => {
    await wait(30)
  })
  assert.ok(view.container.querySelector('.dns-strip'))

  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.tabIndex = 0
  card.appendChild(editor)
  document.body.appendChild(card)
  editor.focus()
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => {
    editor.dispatchEvent(event)
  })
  assert.equal(view.container.querySelector('.dns-strip'), null, 'Escape hides')
  assert.ok(event.defaultPrevented)
  await act(async () => {
    view.root.unmount()
  })
})

test('dismissing one candidate hides it and stops similar recommendations', async () => {
  const dock = setup('conversation.input.dock')
  let round = 0
  const props = {
    session: { sessionId: 's4', running: true, blank: false, pendingInteraction: null },
    input: { draft: '' },
    inputActions: { setDraft: () => {} },
    t: makeT('zh'),
    form: makeForm(),
    requestPrediction: async () => {
      round += 1
      return {
        candidates: [
          { text: '把这三个失败用例修了' },
          { text: '提交刚才的改动并写 commit' },
        ],
      }
    },
    focusComposer: () => {},
  }
  const view = mount(dock.component, props)
  await view.render({})
  await view.render({ session: { ...props.session, running: false } })
  await act(async () => {
    await wait(30)
  })
  const x = view.container.querySelector('.dns-chip-x')
  await act(async () => {
    x.click()
  })
  assert.equal(view.container.querySelectorAll('.dns-chip-text').length, 1)

  await view.render({ session: { ...props.session, running: true } })
  await view.render({ session: { ...props.session, running: false } })
  await act(async () => {
    await wait(30)
  })
  const texts = [...view.container.querySelectorAll('.dns-chip-text')].map((node) => node.textContent)
  assert.ok(!texts.includes('把这三个失败用例修了'), 'dismissed text stays out')
  assert.ok(texts.includes('提交刚才的改动并写 commit'))
  await act(async () => {
    view.root.unmount()
  })
})

test('1.5 s without a result shows nothing', async () => {
  const dock = setup('conversation.input.dock')
  const props = {
    session: { sessionId: 's5', running: true, blank: false, pendingInteraction: null },
    input: { draft: '' },
    inputActions: { setDraft: () => {} },
    t: makeT('zh'),
    form: makeForm(),
    requestPrediction: () => new Promise(() => {}),
    focusComposer: () => {},
  }
  const view = mount(dock.component, props)
  await view.render({})
  await view.render({ session: { ...props.session, running: false } })
  await act(async () => {
    await wait(1650)
  })
  assert.equal(view.container.querySelector('.dns-strip'), null)
  assert.equal(view.container.textContent.trim(), '', 'no loading UI')
  await act(async () => {
    view.root.unmount()
  })
})

test('debug mode shows tokens and latency', async () => {
  const dock = setup('conversation.input.dock', { value: { debug: true } })
  const props = {
    session: { sessionId: 's6', running: true, blank: false, pendingInteraction: null },
    input: { draft: '' },
    inputActions: { setDraft: () => {} },
    t: makeT('zh'),
    form: makeForm({ debug: true }),
    requestPrediction: async () => ({
      candidates: [{ text: '把这三个失败用例修了' }],
      meta: { inputTokens: 120, outputTokens: 30, ms: 800, calls: 1 },
    }),
    focusComposer: () => {},
  }
  const view = mount(dock.component, props)
  await view.render({})
  await view.render({ session: { ...props.session, running: false } })
  await act(async () => {
    await wait(30)
  })
  const meta = view.container.querySelector('.dns-meta')
  assert.ok(meta, 'debug meta')
  assert.match(meta.textContent, /150 tok/)
  assert.match(meta.textContent, /0\.8 秒/)
  await act(async () => {
    view.root.unmount()
  })
})

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
