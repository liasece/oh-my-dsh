/**
 * 交互测试：把合并后 client.js 里峰谷动态的组件挂进 jsdom，真的点一下开关与按钮。
 *
 * 渲染到字符串只能证明"长什么样"；这个文件证明"点了会发生什么"——
 * v0.6 起开关只改配置里的布尔值，不再碰会话的模型选择。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

/** 装上 jsdom 全局，让 React 18 的 createRoot 可用。 */
function withDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  // Node 里 navigator 是只有 getter 的全局；统一用 defineProperty 装拆。
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent', 'Node']
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

/** 模型目录夹具：两个 provider，各两个模型。 */
const CATALOG = [
  { id: 'p-peak', models: [{ id: 'm-peak', name: 'Peak Model' }, { id: 'm-peak-2', name: 'Peak Two' }] },
  { id: 'p-off', models: [{ id: 'm-off', name: 'Off Model' }] },
]

/** 执行 client.js，取出注册面。 */
function loadClient() {
  const source = readFileSync(clientPath, 'utf8')
  let registration
  // 代理到「当下」的 jsdom：模块在 mount 之前就加载了，不能把这一刻的 DOM 写死。
  const windowStub = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    addEventListener(...args) { return globalThis.window?.addEventListener?.(...args) },
    removeEventListener(...args) { return globalThis.window?.removeEventListener?.(...args) },
    get innerWidth() { return globalThis.window?.innerWidth ?? 1024 },
    get innerHeight() { return globalThis.window?.innerHeight ?? 768 },
  }
  const documentStub = {
    get body() { return globalThis.document?.body },
    get head() { return globalThis.document?.head ?? { appendChild() {} } },
    querySelector(selector) { return globalThis.document?.querySelector(selector) ?? null },
    createElement(tag) { return globalThis.document?.createElement(tag) ?? { dataset: {}, remove() {} } },
    addEventListener(...args) { return globalThis.document?.addEventListener?.(...args) },
    removeEventListener(...args) { return globalThis.document?.removeEventListener?.(...args) },
  }
  const factory = new Function('window', 'document', 'setInterval', 'clearInterval', 'module', 'exports', source)
  factory(windowStub, documentStub, () => 0, () => {}, { exports: {} }, {})
  assert.ok(registration !== undefined, 'client.js 必须注册模块')
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    // 合并后模块顶层就要构造 Remote spec（Typert 服务 ohMyDsh）。
    if (specifier === 'zod') return require('zod')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === 'react-dom') return require('react-dom')
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

/** 收集一次 apply 得到的注册项，返回组件与注册参数。 */
async function collect(exports, { remote, configForms, shortcuts } = {}) {
  const registered = new Map()
  const dictionaries = new Map()
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
      // 用真实中文词典做替身：占位符替换才测得到。
      bind: (ns) => (key) => {
        const zh = dictionaries.get(ns)?.zh
        return zh?.[key] ?? key
      },
    },
    sessions: { binding: () => undefined },
    remote: {
      $mount: async () => () => {},
      ...(remote ?? {
        session: {
          selectModel: async () => ({ ok: true, value: {} }),
          modelCatalog: async () => ({ ok: true, value: { groups: CATALOG } }),
        },
      }),
    },
    // 合并后的 apply 在 mount 之后用 ctx.inject 等 remote.ohMyDsh；替身直接同步回调。
    inject: (deps, callback) => {
      callback(ctx)
      const done = Promise.resolve()
      done.dispose = async () => {}
      return done
    },
    get: (name) => (name === 'configForms' ? configForms : name === 'shortcuts' ? shortcuts : undefined),
    slots: {
      inject: (_slot, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        // 同一个 id 会出现在多个槽位（设置页与它的导航图标），测试只取第一次，
        // 也就是页面本身的注册项。
        if (!registered.has(options.id)) registered.set(options.id, { options, component })
        return () => {}
      },
    },
  }
  await exports.apply(ctx)
  registered.dictionaries = dictionaries
  return registered
}

/** 挂载一个组件并等它稳定。 */
async function mount(Component, props) {
  const { dom, restore } = withDom()
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  const { act } = require('react-dom/test-utils')
  await act(async () => {
    root.render(React.createElement(Component, props))
  })
  return {
    act,
    container,
    dom,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      restore()
    },
  }
}

/** 造一个配置表单替身。 */
function fakeForm({ sessions = {}, peakWindows, writable = true } = {}) {
  let current = {
    enabled: true,
    sessions,
    peakWindows: peakWindows ?? [
      { start: '09:00', end: '12:00', provider: 'p-peak', model: 'm-peak' },
      { start: '14:00', end: '18:00', provider: 'p-peak', model: 'm-peak' },
    ],
  }
  const writes = []
  const snapshot = () => ({
    status: 'ready',
    value: {
      peakValley: {
        enabled: { get: () => current.enabled !== false },
        sessions: { get: () => ({ ...current.sessions }) },
        peakWindows: { get: () => current.peakWindows.map((row) => ({ ...row })) },
        timeZone: { get: () => current.timeZone ?? 'Asia/Shanghai' },
        offPeakRoute: { get: () => ({ provider: 'p-off', model: 'm-off' }) },
      },
    },
    writable,
    revision: 1,
  })
  const apply = (field, next) => {
    if (field === 'enabled') current = { ...current, enabled: next }
    if (field === 'sessions') current = { ...current, sessions: next }
    if (field === 'peakWindows') current = { ...current, peakWindows: next }
    if (field === 'timeZone') current = { ...current, timeZone: next }
    if (field === 'offPeakRoute') current = { ...current, offPeakRoute: next }
  }
  return {
    getSnapshot: snapshot,
    subscribe: () => () => {},
    set: async (field, next) => {
      writes.push({ field, value: next })
      apply(field, next)
      return true
    },
    mutate: async (ops) => {
      writes.push({ ops })
      // 合并后路径是 [段名, 字段]；旧用例只写一段，这里按最后一段落值。
      for (const op of ops) if (op.op === 'set') apply(op.path[op.path.length - 1], op.value)
      return true
    },
    writes,
  }
}

test('点开关（关着）→ 把本会话记入 sessions，不碰模型选择', async () => {
  const form = fakeForm({ sessions: {} })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const injected = options.inject('s1')

  const ui = await mount(Chip, {
    ...injected,
    useConfig: (selector) => selector?.(form.getSnapshot()),
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })

  const button = ui.container.querySelector('button.pvm-switch')
  assert.ok(button !== null, '应渲染出开关')
  assert.equal(button.getAttribute('data-on'), 'false')

  await ui.act(async () => {
    button.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })

  // 两处：本会话的显式状态 + 「最近一次动作」（供之后新建的会话继承）。
  assert.equal(form.writes.length, 1, '应只写一次')
  const ops = form.writes[0].ops
  assert.deepEqual(ops[0], { op: 'set', path: ['peakValley', 'sessions'], value: { s1: true } })
  assert.equal(ops[1].path[1], 'lastToggle')
  assert.equal(ops[1].value.on, true, '最近一次动作应记为「开」')
  assert.equal(typeof ops[1].value.at, 'number')
  assert.ok(ops[1].value.at > 0, '应记下动作时间：新建会话靠它判断继承')

  await ui.unmount()
})

test('打开开关不即时改模型位（避免在轮次中途换路由）', async () => {
  const calls = []
  const form = fakeForm({ sessions: {} })
  const exports = loadClient()
  const registrations = await collect(exports, {
    configForms: { get: () => form },
    remote: {
      session: {
        selectModel: async (request) => { calls.push(request); return { ok: true, value: {} } },
        modelCatalog: async () => ({ ok: true, value: { groups: CATALOG } }),
      },
    },
  })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const injected = options.inject('s1')

  const ui = await mount(Chip, {
    ...injected,
    useConfig: (selector) => selector?.(form.getSnapshot()),
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })

  await ui.act(async () => {
    ui.container.querySelector('button.pvm-switch').dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(form.writes[0].ops[0], { op: 'set', path: ['peakValley', 'sessions'], value: { s1: true } }, '写开关状态')
  assert.equal(form.writes[0].ops[1].path[1], 'lastToggle', '并记下最近一次动作')
  assert.equal(calls.length, 0, '不应在这里改模型位：轮次中途换路由会让服务端拒绝 thinking 重放')

  await ui.unmount()
})

test('点开关（开着）→ 把这个会话从 sessions 里删掉', async () => {
  const form = fakeForm({ sessions: { s1: true } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const injected = options.inject('s1')

  const ui = await mount(Chip, {
    ...injected,
    useConfig: (selector) => selector?.(form.getSnapshot()),
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })

  const button = ui.container.querySelector('button.pvm-switch')
  assert.equal(button.getAttribute('data-on'), 'true', '开着时应显示为开')

  await ui.act(async () => {
    button.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })

  const ops = form.writes[0].ops
  assert.deepEqual(ops[0], { op: 'set', path: ['peakValley', 'sessions'], value: {} }, '关闭即删键，不留 false 条目')
  assert.equal(ops[1].value.on, false, '最近一次动作应记为「关」')

  await ui.unmount()
})

test('写开关失败时开关回到可用状态，并把原因留在 title 上', async () => {
  const form = fakeForm({ sessions: {} })
  form.mutate = async () => { throw new Error('宿主拒绝了写入') }
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const injected = options.inject('s1')

  const ui = await mount(Chip, {
    ...injected,
    useConfig: (selector) => selector?.(form.getSnapshot()),
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })

  const button = ui.container.querySelector('button.pvm-switch')
  await ui.act(async () => {
    button.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })

  const after = ui.container.querySelector('button.pvm-switch')
  assert.equal(after.disabled, false, '失败后必须能再点，不能卡在 disabled')
  assert.match(String(after.getAttribute('title')), /宿主拒绝了写入/)
  // 失败必须看得见，不能只藏在 title 里。
  const label = after.querySelector('.pvm-switchLabel')
  assert.equal(label.getAttribute('data-error'), 'true')
  assert.match(label.textContent, /开关失败/)

  await ui.unmount()
})

test('齿轮按钮 → 就地弹出设置面板（portal 到 body），点外部关闭', async () => {
  const form = fakeForm({ sessions: { s1: true } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const injected = options.inject('s1')

  const ui = await mount(Chip, {
    ...injected,
    useConfig: (selector) => selector?.(form.getSnapshot()),
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })

  const doc = ui.dom.window.document
  assert.equal(doc.body.querySelector('.pvm-panel'), null, '默认不展开')

  const gear = ui.container.querySelector('button.pvm-gear')
  assert.ok(gear !== null, '开关旁必须有设置入口')
  await ui.act(async () => {
    gear.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })

  const panel = doc.body.querySelector('.pvm-panel')
  assert.ok(panel !== null, '点齿轮应展开设置面板（portal 到 body，避免被输入框裁切）')
  assert.ok(panel.querySelectorAll('select.pvm-select').length > 0, '面板里应有可编辑的下拉项')

  // 点面板外的区域应关闭。
  await ui.act(async () => {
    doc.body.dispatchEvent(new ui.dom.window.MouseEvent('mousedown', { bubbles: true }))
  })
  assert.equal(doc.body.querySelector('.pvm-panel'), null, '点外部应关闭')

  await ui.unmount()
})

test('设置页：没有任何保存按钮，改一下就直接写入', async () => {
  const form = fakeForm({ sessions: { s1: true } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })
  const { act, Simulate } = require('react-dom/test-utils')

  assert.equal(
    [...ui.container.querySelectorAll('button')].some((b) => /保存/.test(b.textContent)),
    false,
    '设置页不应再有保存按钮',
  )

  const writes = () => form.writes.filter((w) => w.ops !== undefined)

  // 改时间：立即写入整张时段表
  await act(async () => { Simulate.change(ui.container.querySelectorAll('select.pvm-select')[0], { target: { value: '10:00' } }) })
  assert.equal(writes().length, 1, '改时间应立刻写一次')
  assert.equal(writes()[0].ops[0].path[1], 'peakWindows')
  assert.equal(writes()[0].ops[0].value[0].start, '10:00')

  // 改模型：再写一次
  await act(async () => { Simulate.change(ui.container.querySelectorAll('select.pvm-select')[3], { target: { value: 'm-peak-2' } }) })
  assert.equal(writes().length, 2)
  assert.equal(writes()[1].ops[0].value[0].model, 'm-peak-2')

  // 改时区：只写时区
  const count = ui.container.querySelectorAll('select.pvm-select').length
  await act(async () => { Simulate.change(ui.container.querySelectorAll('select.pvm-select')[count - 1], { target: { value: 'UTC' } }) })
  assert.equal(writes().length, 3)
  assert.deepEqual(writes()[2].ops, [{ op: 'set', path: ['peakValley', 'timeZone'], value: 'UTC' }], '只写变了的字段')

  // 改窗口外路由：只写路由
  await act(async () => { Simulate.change(ui.container.querySelectorAll('select.pvm-select')[count - 3], { target: { value: 'p-off' } }) })
  assert.equal(writes().length, 4)
  assert.deepEqual(writes()[3].ops, [{ op: 'set', path: ['peakValley', 'offPeakRoute'], value: { provider: 'p-off', model: 'm-off' } }])

  await ui.unmount()
})

test('设置页：换 provider 时模型自动落到该 provider 的第一个模型', async () => {
  const form = fakeForm({ sessions: { s1: true } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })
  const { act, Simulate } = require('react-dom/test-utils')
  const selects = () => ui.container.querySelectorAll('select.pvm-select')

  // 第 1 段的 provider（索引 2）改成 p-off，其模型只有 m-off
  await act(async () => { Simulate.change(selects()[2], { target: { value: 'p-off' } }) })
  assert.equal(selects()[3].value, 'm-off', '模型应跟随 provider')

  // 换 provider 本身就是一次修改，应立即写入，且模型跟着换成该 provider 的第一个。
  const write = form.writes.find((w) => w.ops !== undefined)
  assert.deepEqual(write.ops[0].value[0], { start: '09:00', end: '12:00', provider: 'p-off', model: 'm-off' })

  await ui.unmount()
})

test('设置页：配置里不在目录中的值仍保留为选项（不擅自改配置）', async () => {
  const form = fakeForm({
    enabled: true,
    peakWindows: [{ start: '09:07', end: '11:00', provider: 'gone-provider', model: 'gone-model' }],
  })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })
  const selects = () => ui.container.querySelectorAll('select.pvm-select')

  assert.equal(selects()[0].value, '09:07', '不在 15 分钟网格上的时间必须原样保留')
  assert.equal(selects()[2].value, 'gone-provider', '目录里没有的 provider 也要保留')
  assert.equal(selects()[3].value, 'gone-model')

  await ui.unmount()
})

test('设置页：可以增删时段', async () => {
  const form = fakeForm({ sessions: { s1: true } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })

  const before = ui.container.querySelectorAll('select.pvm-select').length
  const addButton = [...ui.container.querySelectorAll('button.pvm-button')].find(
    (button) => button.textContent.includes('添加时段'),
  )
  assert.ok(addButton !== undefined, '应有添加时段按钮')
  await ui.act(async () => {
    addButton.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })
  const after = ui.container.querySelectorAll('select.pvm-select').length
  assert.equal(after, before + 4, '每个时段 4 个下拉：起、止、provider、model')

  const removeButtons = [...ui.container.querySelectorAll('button.pvm-linkButton')]
  assert.equal(removeButtons.length, 3, '三段各有一个删除按钮')
  await ui.act(async () => {
    removeButtons[0].dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(ui.container.querySelectorAll('select.pvm-select').length, before, '删回两段')

  await ui.unmount()
})

test('设置页：可一键清空按会话覆盖', async () => {
  const form = fakeForm({ enabled: true, sessions: { s1: false } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })

  const buttons = [...ui.container.querySelectorAll('button.pvm-button')]
  const clearButton = buttons[buttons.length - 1]
  await ui.act(async () => {
    clearButton.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
  })

  const write = form.writes.find((w) => w.ops !== undefined && w.ops[0].path[1] === 'sessions')
  assert.ok(write !== undefined, '应写入 sessions')
  assert.deepEqual(write.ops, [{ op: 'set', path: ['peakValley', 'sessions'], value: {} }])

  await ui.unmount()
})

test('设置页：路由为空时不写入，只提示（目录为空也不能存半套配置）', async () => {
  const form = fakeForm({
    sessions: { s1: true },
    peakWindows: [{ start: '09:00', end: '12:00', provider: '', model: '' }],
  })
  const exports = loadClient()
  const registrations = await collect(exports, {
    configForms: { get: () => form },
    // 目录为空：下拉只有占位项，provider/model 只能是空字符串
    remote: {
      session: {
        selectModel: async () => ({ ok: true, value: {} }),
        modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
      },
    },
  })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })
  const { act, Simulate } = require('react-dom/test-utils')

  // 改一个时间：整表仍缺 provider/model，必须拒绝写入
  await act(async () => {
    Simulate.change(ui.container.querySelectorAll('select.pvm-select')[0], { target: { value: '10:00' } })
  })

  assert.equal(form.writes.filter((w) => w.ops !== undefined).length, 0, '不应写入半套配置')
  assert.ok(ui.container.querySelector('.pvm-error') !== null, '应显示校验错误')

  await ui.unmount()
})

test('设置页：增删时段立即写入', async () => {
  const form = fakeForm({ sessions: { s1: true } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })
  const { act } = require('react-dom/test-utils')
  const writes = () => form.writes.filter((w) => w.ops !== undefined)
  const click = async (label) => {
    const button = [...ui.container.querySelectorAll('button')].find((b) => b.textContent === label)
    assert.ok(button !== undefined, `应有「${label}」按钮`)
    await act(async () => {
      button.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }))
    })
  }

  await click('添加时段')
  assert.equal(writes().length, 1, '新增应立即写入')
  assert.equal(writes()[0].ops[0].value.length, 3, '写入三段')

  await click('删除')
  assert.equal(writes().length, 2, '删除应立即写入')
  assert.equal(writes()[1].ops[0].value.length, 2, '写回两段')

  await ui.unmount()
})

test('设置页：写入落地前的配置推送不会把刚改的值冲掉', async () => {
  const form = fakeForm({ sessions: { s1: true } })
  const exports = loadClient()
  const registrations = await collect(exports, { configForms: { get: () => form } })
  const { component: Settings, options } = registrations.get('oh-my-dsh.peak-valley')
  const injected = options.inject()

  // 让写入悬停，模拟「已改、尚未落库」的窗口期。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const originalMutate = form.mutate
  form.mutate = async (ops) => {
    await gate
    return originalMutate(ops)
  }

  const ui = await mount(Settings, {
    ...injected,
    t: (key) => registrations.dictionaries.get('oh-my-dsh.peak-valley').zh[key] ?? key,
  })
  const { act, Simulate } = require('react-dom/test-utils')

  await act(async () => {
    Simulate.change(ui.container.querySelectorAll('select.pvm-select')[0], { target: { value: '10:00' } })
  })

  // 写入还没落地时，别的推送（此时快照仍是旧值）不应把下拉打回去。
  assert.equal(ui.container.querySelectorAll('select.pvm-select')[0].value, '10:00', '用户刚选的值应留在界面上')

  await act(async () => { release() })
  await ui.unmount()
})
