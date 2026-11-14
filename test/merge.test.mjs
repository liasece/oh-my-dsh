/**
 * 合并层的契约测试：一个包、一次挂载、三个功能各自的入口。
 *
 * 这里不重复各功能的细节（那些在 peak-valley-* 与 history 的用例里），
 * 只守合并本身容易漏掉的东西：
 *   - 模块 id 与 inject 列表覆盖三个功能的需求；
 *   - 三个功能各自占的槽位 id、顺序与所属槽位；
 *   - 两个 Remote 方法挂在同一个 `ohMyDsh` 服务上；
 *   - 四份字典都注册了，设置页才会显示成中文；
 *   - 功能开关真的能挡住行为（输入历史与提示词候选各一条）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const React = require('react')
const { JSDOM } = require('jsdom')

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

/** 装上 jsdom 全局，让 React 18 的 createRoot 可用。 */
function withDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'Event']
  const previous = new Map()
  for (const key of keys) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  for (const key of keys) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return {
    dom,
    restore() {
      for (const key of keys) {
        const descriptor = previous.get(key)
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      dom.window.close()
    },
  }
}

/** 执行 client.js，返回它注册的模块说明。 */
function loadClient() {
  const source = readFileSync(clientPath, 'utf8')
  let registration
  const windowStub = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    addEventListener() {},
    removeEventListener() {},
    get innerWidth() { return globalThis.window?.innerWidth ?? 1024 },
    get innerHeight() { return globalThis.window?.innerHeight ?? 768 },
  }
  const documentStub = {
    get body() { return globalThis.document?.body },
    get head() { return globalThis.document?.head ?? { appendChild() {} } },
    querySelector(selector) { return globalThis.document?.querySelector(selector) ?? null },
    createElement(tag) { return globalThis.document?.createElement(tag) ?? { dataset: {}, remove() {} } },
    addEventListener() {},
    removeEventListener() {},
  }
  const factory = new Function('window', 'document', 'setInterval', 'clearInterval', 'module', 'exports', source)
  factory(windowStub, documentStub, () => 0, () => {}, { exports: {} }, {})
  assert.ok(registration !== undefined, 'client.js 必须调用模块加载器注册自己')
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === 'react-dom') return require('react-dom')
    if (specifier === 'zod') return require('zod')
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        MenuSurface: ({ children, ...rest }) => React.createElement('div', rest, children),
        IconSettingsOutlineRegular: (props) => React.createElement('svg', { 'data-icon': 'settings', ...props }),
        IconCloseOutlineRegular: (props) => React.createElement('svg', { 'data-icon': 'close', ...props }),
      }
    }
    throw new Error(`未预期的依赖: ${specifier}`)
  })
}

/** 收集一次 apply 的注册面。 */
async function applyClient(exports, { configForms, remote, shortcuts } = {}) {
  const slots = new Map()
  const dictionaries = new Map()
  const mounted = []
  const ctx = {
    effect: (factory) => {
      const value = factory()
      return typeof value === 'function' ? value : () => {}
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.set(ns, dicts)
        return () => {}
      },
      bind: (ns) => (key) => dictionaries.get(ns)?.zh?.[key] ?? key,
    },
    sessions: { binding: () => undefined },
    shortcuts: shortcuts ?? { observeFixedInput: () => () => {} },
    remote: {
      $mount: async (spec) => {
        mounted.push(spec)
        return () => {}
      },
      ...(remote ?? {}),
      session: { selectModel: async () => ({ ok: true, value: {} }), modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    },
    get: (name) => (name === 'configForms' ? configForms : name === 'shortcuts' ? shortcuts : undefined),
    slots: {
      inject: (slot, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        slots.set(`${options.name}#${options.id}`, { options, component })
        return () => {}
      },
    },
    inject: (deps, callback) => {
      callback(ctx)
      const done = Promise.resolve()
      done.dispose = async () => {}
      return done
    },
  }
  await exports.apply(ctx)
  return { slots, dictionaries, mounted }
}

test('合并后：一个模块、一次挂载、两个 Remote 方法', async () => {
  const exports = loadClient()
  assert.equal(typeof exports.apply, 'function')
  for (const service of ['slots', 'remote', 'shortcuts', 'sessions', 'locale', 'remote.session']) {
    assert.ok(exports.inject.includes(service), `inject 需要 ${service}`)
  }
  assert.ok(!exports.inject.includes('remote.ohMyDsh'), 'remote.ohMyDsh 由 apply 内部挂载后再等，不写在 inject 里')

  const { mounted } = await applyClient(exports)
  assert.equal(mounted.length, 1, '三个功能共用一次 $mount')
  const spec = mounted[0]
  assert.equal(spec.package, 'oh-my-dsh')
  assert.deepEqual(Object.keys(spec.methods).sort(), ['ohMyDsh/candidates', 'ohMyDsh/history'])
  assert.equal(spec.methods['ohMyDsh/candidates'].service, 'ohMyDsh')
  assert.equal(spec.methods['ohMyDsh/history'].service, 'ohMyDsh')
})

test('合并后：三个功能各自的槽位都在，设置合成一页', async () => {
  const exports = loadClient()
  const { slots, dictionaries } = await applyClient(exports)

  const dock = [...slots.values()].filter((entry) => entry.options.name === 'conversation.input.dock')
  assert.deepEqual(dock.map((entry) => entry.options.id), ['oh-my-dsh.candidates', 'oh-my-dsh.history'], '候选在上、历史在下')
  assert.deepEqual(dock.map((entry) => entry.options.order), [30, 40])

  const right = slots.get('conversation.input.right#oh-my-dsh.peak-valley-toggle')
  assert.ok(right !== undefined, '输入框右侧应有峰谷动态开关')

  const pages = [...slots.values()].filter((entry) => entry.options.name === 'settings.section')
  assert.deepEqual(pages.map((entry) => entry.options.id), ['oh-my-dsh'], '所有设置收在唯一一页里')
  assert.deepEqual(pages.map((entry) => entry.options.order), [35])
  assert.equal(pages[0].options.label(), 'OhMyDSH', '导航名就是插件名')

  const icons = [...slots.values()].filter((entry) => entry.options.name === 'settings.section.icon')
  assert.deepEqual(icons.map((entry) => entry.options.id), ['oh-my-dsh'], '唯一一页配唯一一个导航图标')

  for (const ns of ['oh-my-dsh.page', 'oh-my-dsh.peak-valley', 'oh-my-dsh.candidates', 'oh-my-dsh.history']) {
    assert.ok(dictionaries.has(ns), `应注册 ${ns} 的字典`)
    assert.ok(Object.keys(dictionaries.get(ns).zh).length > 0)
    assert.ok(Object.keys(dictionaries.get(ns).en).length > 0)
  }
})

/** 一个只回放固定值的配置表单替身。 */
function fakeForm(value, { writable = true } = {}) {
  const writes = []
  return {
    writes,
    getSnapshot: () => ({ status: 'ready', value, writable, revision: 1 }),
    subscribe: () => () => {},
    mutate: async (ops) => {
      writes.push(ops)
      return true
    },
  }
}

/** 历史段的配置快照（每个字段都是 volatile 引用）。 */
const historySection = (enabled) => ({
  history: { enabled: { get: () => enabled }, limit: { get: () => 100 } },
})

/** 挂载一个不渲染 DOM 的组件，返回 act/unmount。 */
async function mount(Component, props) {
  const { dom, restore } = withDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const { createRoot } = require('react-dom/client')
  const root = createRoot(container)
  const act = async (body) => {
    let result
    await require('react-dom/test-utils').act(async () => {
      result = body === undefined ? undefined : await body()
    })
    return result
  }
  await act(async () => { root.render(React.createElement(Component, props)) })
  return {
    dom,
    container,
    act,
    async unmount() {
      await act(async () => { root.unmount() })
      restore()
    },
  }
}

/** 造一条输入框按键事件（与宿主 observeFixedInput 的形状一致）。 */
function keyEvent(target, code) {
  const consumed = { value: false }
  return {
    consumed,
    event: {
      type: 'keydown',
      gesture: {
        code,
        composing: false,
        defaultPrevented: false,
        control: false,
        alt: false,
        meta: false,
        shift: false,
      },
      context: { region: 'editable', modal: null, target },
      consume() { consumed.value = true },
    },
  }
}

test('输入历史：草稿为空时按 ↑ 召回最近一条；关掉后不接管', async () => {
  const exports = loadClient()

  for (const enabled of [true, false]) {
    const listeners = []
    const shortcuts = { observeFixedInput: (listener) => { listeners.push(listener); return () => {} } }
    const form = fakeForm(historySection(enabled))
    const { slots } = await applyClient(exports, {
      configForms: { get: () => form },
      shortcuts,
      remote: {
        ohMyDsh: {
          history: async () => ({ ok: true, value: { messages: ['第一条', '第二条'] } }),
          candidates: async () => ({ ok: true, value: { suggestions: [], reason: 'disabled' } }),
        },
      },
    })

    const entry = slots.get('conversation.input.dock#oh-my-dsh.history')
    assert.ok(entry !== undefined, '输入历史应占 dock 槽位')

    /** 输入框状态：草稿空、阶段 plain。 */
    const input = { draft: '', phase: 'plain', attachmentIds: [] }
    const drafts = []
    const inputActions = {
      setDraft: (text) => drafts.push(text),
      insertText: () => true,
      captureInsertion: () => undefined,
      focus: () => {},
    }

    const ui = await mount(entry.component, {
      ...entry.options.inject(),
      sessionId: 's1',
      useInput: (selector) => selector(input),
      inputActions,
    })

    // 编辑器座位：`[data-composer-input]` 是 composer 自己的编辑区标记。
    const editor = ui.dom.window.document.createElement('div')
    editor.setAttribute('data-composer-input', '')
    editor.tabIndex = 0
    ui.dom.window.document.body.appendChild(editor)
    editor.focus()

    await ui.act(async () => {})
    assert.ok(listeners.length > 0, '应挂上按键观察')

    // 等一次载入历史（挂载时就会读一次）。
    await ui.act(async () => { await Promise.resolve() })

    const { event, consumed } = keyEvent(editor, 'ArrowUp')
    await ui.act(async () => {
      for (const listener of listeners) listener(event)
      await Promise.resolve()
    })

    if (enabled) {
      assert.deepEqual(drafts, ['第二条'], '应把最近一条填进草稿')
      assert.equal(consumed.value, true, '取走的按键不该再传给编辑器')
    } else {
      assert.deepEqual(drafts, [], '关掉后不该碰草稿')
      assert.equal(consumed.value, false, '关掉后按键保持原生')
    }

    await ui.unmount()
  }
})

test('提示词候选：关掉后不请求，也不渲染', async () => {
  const exports = loadClient()
  for (const enabled of [true, false]) {
    let calls = 0
    const form = fakeForm({ candidates: { enabled: { get: () => enabled }, maxSuggestions: { get: () => 2 }, historyMessages: { get: () => 12 } } })
    const { slots } = await applyClient(exports, {
      configForms: { get: () => form },
      remote: {
        ohMyDsh: {
          candidates: async () => {
            calls += 1
            return { ok: true, value: { suggestions: [], reason: 'disabled' } }
          },
          history: async () => ({ ok: true, value: { messages: [] } }),
        },
      },
    })

    const entry = slots.get('conversation.input.dock#oh-my-dsh.candidates')
    const ui = await mount(entry.component, {
      ...entry.options.inject(),
      sessionId: 's1',
      useSession: (selector) => selector({ running: false }),
      useInput: (selector) => selector({ draft: '', phase: 'plain', attachmentIds: [] }),
      inputActions: { setDraft() {}, insertText: () => true, captureInsertion: () => undefined, focus() {} },
      t: (key) => key,
    })
    await ui.act(async () => { await Promise.resolve() })

    assert.equal(calls, enabled ? 1 : 0, enabled ? '开着时应请求一次' : '关掉后不该发请求')
    if (!enabled) assert.equal(ui.container.innerHTML, '', '关掉后槽位里不该有内容')

    await ui.unmount()
  }
})
