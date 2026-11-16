/**
 * 用真实 React 渲染合并后 client.js 里峰谷动态的两个组件，验证：
 *  - 模块加载后能拿到 inject / apply；
 *  - 胶囊在托管/未托管下渲染不同文本与状态；
 *  - 设置页在可写与不可写两种情形下的表现。
 *
 * 这里不模拟 Harness 的整棵 React 树，只按注册契约把 inject 的产物当作 props 喂进去。
 * 合并后 apply 变成异步（先挂 Typert 服务再注册界面），所以测试里的 apply 一律 await。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

/** 用最小模块表执行 client.js，返回它注册的 factory 结果。 */
function loadClient({ withoutPrimitives = false } = {}) {
  const source = readFileSync(clientPath, 'utf8')
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { registration = value } } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const moduleTable = {
    react: React,
    // 合并后模块顶层就要构造 Remote spec（Typert 服务 ohMyDsh）。
    zod: require('zod'),
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-dom': require('react-dom'),
    // 宿主基线原语：测试里用最小替身，只要有 MenuSurface 与两个图标即可。
    '@deepseek-ai/dsh-client-ui-primitives': {
      MenuSurface: ({ children, ...rest }) => React.createElement('div', rest, children),
      IconSettingsOutlineRegular: (props) => React.createElement('svg', { 'data-icon': 'settings', ...props }),
      IconCloseOutlineRegular: (props) => React.createElement('svg', { 'data-icon': 'close', ...props }),
    },
  }
  if (withoutPrimitives) delete moduleTable['@deepseek-ai/dsh-client-ui-primitives']
  const factory = new Function(
    'window',
    'document',
    'setInterval',
    'clearInterval',
    'module',
    'exports',
    source.replace(/^window\.__ModuleLoader__\.load\(/, 'window.__ModuleLoader__.load('),
  )
  factory(
    sandbox.window,
    sandbox.document,
    sandbox.setInterval,
    sandbox.clearInterval,
    { exports: {} },
    {},
  )
  assert.ok(registration !== undefined, 'client.js 必须调用模块加载器注册自己')
  assert.equal(registration.id, 'oh-my-dsh', '模块 id 必须是合并后的包名')
  const exports = registration.factory((specifier) => {
    const value = moduleTable[specifier]
    if (value === undefined) throw new Error(`未预期的依赖: ${specifier}`)
    return value
  })
  return exports
}

/** 一个只回放固定值的可观察源。 */
const sourceOf = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} })

/** 取组件：通过 apply 抓注册项。 */
async function collectRegistrations(exports, { sessions, remote, configForms, locale } = {}) {
  const registered = new Map()
  /** 按「槽位#id」另存一份，供候选/历史这种跨槽位复用 id 的页面取用。 */
  const bySlot = new Map()
  const ctx = {
    effect: (factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    sessions: sessions ?? { binding: () => undefined },
    remote: {
      $mount: async () => () => {},
      ...(remote ?? { session: { selectModel: async () => ({ ok: true, value: {} }) } }),
    },
    // 合并后的 apply 在 mount 之后用 ctx.inject 等 remote.ohMyDsh；替身直接同步回调。
    inject: (deps, callback) => {
      callback(ctx)
      const done = Promise.resolve()
      done.dispose = async () => {}
      return done
    },
    get: (name) => (name === 'configForms' ? configForms : undefined),
    slots: {
      inject: (slot, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        // 同一个 id 会出现在多个槽位（设置页与它的导航图标），测试只取第一次，
        // 也就是页面本身的注册项。
        if (!registered.has(options.id)) registered.set(options.id, { options, component })
        // 候选与历史的设置页与输入框那一行共用 id，这里再按「槽位#id」存一份。
        bySlot.set(`${options.name}#${options.id}`, { options, component })
        return () => {}
      },
    },
  }
  await exports.apply(ctx)
  registered.bySlot = bySlot
  return registered
}

/** 从整页标记里截出某个功能板块，避免把别的板块的控件算进来。 */
function blockOf(markup, key) {
  const start = markup.indexOf(`data-feature="${key}"`)
  assert.ok(start >= 0, `应有 ${key} 板块`)
  const next = markup.indexOf('data-feature="', start + 1)
  return markup.slice(start, next === -1 ? undefined : next)
}

test('client.js 注册两处入口，且 id 稳定', async () => {
  const exports = loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  for (const service of ['slots', 'locale', 'sessions', 'remote', 'remote.session']) {
    assert.ok(exports.inject.includes(service), `inject 需要 ${service}`)
  }
  // 会话服务用于「开启的瞬间把模型位切过去」，不再用于表达开关状态。
  const registrations = await collectRegistrations(exports)
  assert.ok(registrations.has('oh-my-dsh.peak-valley-toggle'), '输入框右侧应有开关')
  assert.ok(registrations.has('oh-my-dsh'), '设置里应有插件唯一一页')
  assert.equal(registrations.get('oh-my-dsh.peak-valley-toggle').options.name, 'conversation.input.right')
  assert.equal(registrations.get('oh-my-dsh').options.name, 'settings.section',
    '应注册为顶层设置分区，与官方设置页同一方式')
})

/** 造一份配置快照替身（模拟 volatile 引用对象）。 */
function fakeSnapshot({ sessions = {}, peakWindows, enabled = true, writable = true } = {}) {
  return {
    getSnapshot: () => ({
      status: 'ready',
      value: {
        peakValley: {
          enabled: { get: () => enabled },
          sessions: { get: () => sessions },
          peakWindows: { get: () => (peakWindows ?? [
            { start: '09:00', end: '12:00', provider: 'p-peak', model: 'm-peak' },
            { start: '14:00', end: '18:00', provider: 'p-peak', model: 'm-peak' },
          ]) },
          timeZone: { get: () => 'Asia/Shanghai' },
          offPeakRoute: { get: () => ({ provider: 'p-off', model: 'm-off' }) },
        },
      },
      writable,
      revision: 1,
    }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
}

test('开关：本会话已打开显示为开，没打开显示为关', async () => {
  const exports = loadClient()
  const onReg = await collectRegistrations(exports, { configForms: { get: () => fakeSnapshot({ sessions: { s1: true } }) } })
  const onChip = onReg.get('oh-my-dsh.peak-valley-toggle')
  const onMarkup = renderToStaticMarkup(
    React.createElement(onChip.component, {
      ...onChip.options.inject('s1'),
      useConfig: (selector) => selector?.(fakeSnapshot({ sessions: { s1: true } }).getSnapshot()),
      t: (key) => key,
    }),
  )
  assert.match(onMarkup, /data-on="true"/)
  assert.match(onMarkup, /role="switch"/)
  assert.match(onMarkup, /aria-checked="true"/)

  const offReg = await collectRegistrations(exports, { configForms: { get: () => fakeSnapshot({ sessions: {} }) } })
  const offChip = offReg.get('oh-my-dsh.peak-valley-toggle')
  const offMarkup = renderToStaticMarkup(
    React.createElement(offChip.component, {
      ...offChip.options.inject('s1'),
      useConfig: (selector) => selector?.(fakeSnapshot({ sessions: {} }).getSnapshot()),
      t: (key) => key,
    }),
  )
  assert.match(offMarkup, /data-on="false"/)
  assert.match(offMarkup, /aria-checked="false"/)
})

test('开关：渲染出轨道、圆钮与齿轮（不是裸按钮）', async () => {
  const exports = loadClient()
  const registrations = await collectRegistrations(exports, { configForms: { get: () => fakeSnapshot({ sessions: { s1: true } }) } })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const markup = renderToStaticMarkup(
    React.createElement(Chip, {
      ...options.inject('s1'),
      useConfig: (selector) => selector?.(fakeSnapshot({ sessions: { s1: true } }).getSnapshot()),
      t: (key) => key,
    }),
  )
  assert.match(markup, /omd-switchTrack/, '必须有开关轨道')
  assert.match(markup, /omd-switchThumb/, '必须有圆钮')
  assert.match(markup, /pvm-gear/, '必须有设置齿轮')
  assert.doesNotMatch(markup, /pvm-chip/, '不该再有旧的胶囊类名')
})

test('每个设置板块各有一个可访问的胶囊功能开关', async () => {
  const form = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      value: {
        peakValley: {
          enabled: { get: () => true },
          sessions: { get: () => ({}) },
          peakWindows: { get: () => [{ start: '09:00', end: '12:00', provider: 'p-peak', model: 'm-peak' }] },
          timeZone: { get: () => 'Asia/Shanghai' },
          offPeakRoute: { get: () => ({ provider: 'p-off', model: 'm-off' }) },
        },
        candidates: {
          enabled: { get: () => true },
          maxSuggestions: { get: () => 2 },
          historyMessages: { get: () => 12 },
        },
        history: { enabled: { get: () => true }, limit: { get: () => 100 } },
      },
    }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const exports = loadClient()
  const registrations = await collectRegistrations(exports, { configForms: { get: () => form } })

  const { component: Page, options } = registrations.bySlot.get('settings.section#oh-my-dsh')
  const markup = renderToStaticMarkup(React.createElement(Page, { ...options.inject(), t: (key) => key }))
  const features = ['peakValley', 'candidates', 'history', 'sessionCreation']
  assert.equal((markup.match(/class="omd-switch"/g) ?? []).length, features.length, '各功能有独立开关')
  assert.equal((markup.match(/role="switch"/g) ?? []).length, features.length, '每个开关都声明为 switch')
  assert.equal((markup.match(/omd-switchTrack/g) ?? []).length, features.length, '每个开关都有胶囊轨道')
  assert.equal((markup.match(/omd-switchThumb/g) ?? []).length, features.length, '每个开关都有圆钮')
  assert.doesNotMatch(markup, /pvm-button[^>]*role="switch"/, '功能开关不该还是普通按钮')
  for (const key of features) {
    assert.match(markup, new RegExp(`data-feature="${key}"`), `应有 ${key} 板块`)
  }
  assert.equal((markup.match(/data-open="true"/g) ?? []).length, features.length, '功能开着时板块展开')
})

test('功能关掉时板块折叠，板块头与开关仍在', async () => {
  const form = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      value: {
        peakValley: {
          enabled: { get: () => true },
          sessions: { get: () => ({}) },
          peakWindows: { get: () => [] },
          timeZone: { get: () => 'Asia/Shanghai' },
          offPeakRoute: { get: () => ({ provider: 'p-off', model: 'm-off' }) },
        },
        candidates: { enabled: { get: () => false }, maxSuggestions: { get: () => 2 }, historyMessages: { get: () => 12 } },
        history: { enabled: { get: () => true }, limit: { get: () => 100 } },
      },
    }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const exports = loadClient()
  const registrations = await collectRegistrations(exports, { configForms: { get: () => form } })
  const { component: Page, options } = registrations.bySlot.get('settings.section#oh-my-dsh')
  const markup = renderToStaticMarkup(React.createElement(Page, { ...options.inject(), t: (key) => key }))

  const candidatesBlock = blockOf(markup, 'candidates')
  assert.match(candidatesBlock, /data-open="false"/, '功能关闭的板块收起')
  assert.match(candidatesBlock, /aria-hidden="true"/, '收起的内容不暴露给读屏')
  assert.match(candidatesBlock, /inert=""/, '收起的内容不能聚焦')
  assert.match(candidatesBlock, /role="switch"/, '收起后开关还在，能再打开')
  assert.match(candidatesBlock, /settings.title/, '板块头仍显示标题')
  assert.match(candidatesBlock, /settings.enabledHint/, '收起时说明关掉后会发生什么')

  assert.match(blockOf(markup, 'peakValley'), /data-open="true"/, '别的板块不受影响')
})

test('设置页：时段表、窗口外路由、时区都可编辑', async () => {
  const exports = loadClient()
  const registrations = await collectRegistrations(exports, { configForms: { get: () => fakeSnapshot({ sessions: { s1: true } }) } })
  const { component: Settings, options } = registrations.bySlot.get('settings.section#oh-my-dsh')
  const page = renderToStaticMarkup(
    React.createElement(Settings, { ...options.inject(), t: (key) => key }),
  )
  const markup = blockOf(page, 'peakValley')
  // 两段默认时段：每段 4 个下拉（起止 + provider + model），加窗口外 2 个、时区 1 个
  assert.equal((markup.match(/<select/g) ?? []).length, 2 * 4 + 2 + 1, '下拉数量应与时段表一致')
  assert.equal((markup.match(/<input/g) ?? []).length, 0, '设置页不应再有自由文本输入')
  assert.match(markup, /p-peak/, '时段路由应回填')
  assert.match(markup, /m-peak/)
  assert.match(markup, /addWindow/, '应有添加时段按钮')
  assert.match(markup, /offPeakRoute/, '应有窗口外路由')
  assert.match(markup, /defaultState/, '应有新会话默认开关')
  assert.match(markup, /overridesLabel/, '应显示按会话覆盖的数量')
})

test('设置页：时段数量随配置变化', async () => {
  const exports = loadClient()
  const one = fakeSnapshot({
    enabled: true,
    peakWindows: [{ start: '22:00', end: '23:00', provider: 'x', model: 'y' }],
  })
  const registrations = await collectRegistrations(exports, { configForms: { get: () => one } })
  const { component: Settings, options } = registrations.bySlot.get('settings.section#oh-my-dsh')
  const markup = blockOf(
    renderToStaticMarkup(React.createElement(Settings, { ...options.inject(), t: (key) => key })),
    'peakValley',
  )
  assert.equal((markup.match(/<select/g) ?? []).length, 4 + 2 + 1, '一段时段 = 4 个下拉')
  assert.match(markup, /22:00/, '时段起点应回填')
  assert.match(markup, /23:00/)
})

test('功能开关关掉时胶囊不渲染（设置页里仍能打开）', async () => {
  const exports = loadClient()
  const registrations = await collectRegistrations(exports, { configForms: { get: () => fakeSnapshot({ sessions: { s1: true }, enabled: false }) } })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const markup = renderToStaticMarkup(
    React.createElement(Chip, {
      ...options.inject('s1'),
      useConfig: (selector) => selector?.(fakeSnapshot({ sessions: { s1: true }, enabled: false }).getSnapshot()),
      t: (key) => key,
    }),
  )
  assert.equal(markup, '', '关掉功能后输入框右侧不该再有开关')
})

test('拿不到宿主原语时仍能渲染（不让整个开关消失）', async () => {
  const exports = loadClient({ withoutPrimitives: true })
  const registrations = await collectRegistrations(exports, { configForms: { get: () => fakeSnapshot({ sessions: { s1: true } }) } })
  const { component: Chip, options } = registrations.get('oh-my-dsh.peak-valley-toggle')
  const markup = renderToStaticMarkup(
    React.createElement(Chip, { ...options.inject('s1'), useConfig: (selector) => selector?.(fakeSnapshot({ sessions: { s1: true } }).getSnapshot()), t: (key) => key }),
  )
  assert.match(markup, /omd-switch/, '开关本体仍要渲染')
  assert.match(markup, /svg/, '齿轮图标应有兜底实现')
})
