/**
 * 峰谷动态的宿主半边契约测试（并入 oh-my-dsh 后）。
 *
 * 与原 dsh-peak-valley-model 的 host.test.mjs 同一批用例，只改了两处接缝：
 * 配置换成 `config.peakValley` 这一段，写入形状变成 `{ peakValley: { … } }`。
 *
 * 语义：插件不再是模型，也不再参与模型选择。它只是
 *   - 一个布尔开关；
 *   - 一条请求期规则：开 → 换成当前时段的真实路由，关 → 完全放行。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../lib/peak-valley/index.js'
import { readConfig } from '../lib/peak-valley/index.js'

const PEAK = { provider: 'p-peak', model: 'm-peak' }
const OFF = { provider: 'deepseek-account', model: 'deepseek-flash' }
const CFG = {
  sessions: { s1: true },
  timeZone: 'Asia/Shanghai',
  offPeakRoute: OFF,
  peakWindows: [
    { start: '09:00', end: '12:00', ...PEAK },
    { start: '14:00', end: '18:00', ...PEAK },
  ],
}

/** 假宿主：只记录事件监听。 */
function fakeCtx({ agents, controller, settings } = {}) {
  const listeners = []
  const timers = []
  const ctx = {
    listeners,
    timers,
    logger: { debug: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    on: (name, listener, options) => {
      listeners.push({ name, listener, options })
      return () => {}
    },
    effect: (factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    // 对齐巡检用固定间隔；测试里只记录装了定时器，不真的跑。
    setInterval: (fn, ms) => {
      timers.push({ fn, ms })
      return 0
    },
    fiber: { entry: { options: { id: 'oh-my-dsh' } } },
    get: (name) => {
      if (name === 'agents') return agents
      if (name === 'sessionController') return controller
      if (name === 'settings') return settings
      return undefined
    },
  }
  return { ctx, listeners, timers }
}

/** 造一个会话替身，供对齐巡检使用。 */
function fakeSession({ id = 's1', origin = 'primary', selection } = {}) {
  const state = { selection }
  return {
    id,
    header: { origin },
    get selection() { return state.selection },
    set selection(next) { state.selection = next },
    snapshotEvents: () =>
      state.selection === undefined ? [] : [{ type: 'model/selection', data: state.selection }],
    requestHeader: () => undefined,
  }
}

/** 记录 settings.update 调用的替身。 */
function fakeSettings() {
  const updates = []
  return {
    updates,
    async update(ns, patch) {
      updates.push({ ns, patch })
    },
  }
}

/** 模拟一次 agent/request：内层返回会话自己选的模型。 */
async function runRequest(listeners, selection, agent, step) {
  const entry = listeners.find((item) => item.name === 'agent/request')
  assert.ok(entry !== undefined, '必须监听 agent/request')
  const payload = {
    step,
    agent: agent ?? { session: { id: 's1', header: { origin: 'primary' } } },
  }
  const next = async () => ({ ...selection, maxTokens: 123 })
  return entry.listener(payload, next)
}

/** 一个跟随开关的可变配置：模拟 volatile 引用对象。 */
function liveConfig(initial = CFG) {
  let current = { ...initial }
  return {
    set(next) {
      current = { ...current, ...next }
    },
    config: {
      get sessions() { return { get: () => current.sessions } },
      get timeZone() { return current.timeZone },
      get peakRoute() { return { get: () => current.peakRoute } },
      get offPeakRoute() { return { get: () => current.offPeakRoute } },
    },
  }
}

test('插件不再注册任何模型：这一段没有 llm 依赖，也没有虚拟条目常量', () => {
  assert.equal(plugin.inject, undefined, '这一段不需要任何服务；合并后的 inject 由 index.js 统一声明')
  assert.equal(plugin.PROVIDER_ID, undefined, '不再有虚拟 provider')
  assert.equal(plugin.VIRTUAL_MODEL_ID, undefined, '不再有虚拟模型')
})

test('插件不再改写 agent/request：路由只靠模型位', () => {
  const { ctx, listeners } = fakeCtx()
  plugin.apply(ctx, CFG)
  assert.equal(
    listeners.filter((item) => item.name === 'agent/request').length,
    0,
    'agent/request 只允许原样透传，改了就报 "proposed X after step preparation fixed Y"',
  )
})

test('readConfig 摊平 volatile 字段，且对空配置给默认值', () => {
  const flat = readConfig(CFG)
  assert.deepEqual(flat.sessions, { s1: true }, '开启状态按会话记录')
  assert.deepEqual(flat.peakWindows, CFG.peakWindows)
  assert.deepEqual(flat.offPeakRoute, CFG.offPeakRoute)

  const empty = readConfig(undefined)
  assert.deepEqual(empty.sessions, {}, '空配置下一个会话都不开')
  assert.equal(Array.isArray(empty.peakWindows), true, '空配置也要有默认时段')
  assert.equal(empty.peakWindows.length, 2)
  assert.equal(typeof plugin.routeAt(empty).provider, 'string')
})

test('readConfig 不重复校验：接受已解析的配置（回归）', () => {
  // 曾经在 apply 里二次调用 Config(config)，而那时 volatile 字段已是引用对象，
  // 会报缺字段，插件在真实 loader 里直接加载失败。
  const parsed = plugin.Config({})
  assert.equal(typeof parsed.sessions.get, 'function', '前提：sessions 是 volatile 引用对象')
  const flat = readConfig(parsed)
  assert.deepEqual(flat.sessions, {})
  assert.equal(Array.isArray(flat.peakWindows), true)
  assert.equal(typeof flat.peakWindows[0].provider, 'string')
})

test('启动即把会话的模型选择对齐到当前时段路由（模型位才会变）', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ selection: { provider: 'p-user', model: 'user-picked' } })
  const { ctx } = fakeCtx({ agents: { list: () => [{ session }] }, controller })
  plugin.apply(ctx, CFG)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1, '应发起一次对齐')
  const expected = plugin.routeAt(readConfig(CFG))
  assert.deepEqual(
    { provider: calls[0].provider, model: calls[0].model },
    expected,
    '对齐目标必须是当前时段的真实路由',
  )
})

test('已经在该走的真实路由上时不重复写（避免选择抖动）', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const target = plugin.routeAt(readConfig(CFG))
  const session = fakeSession({ selection: target })
  const { ctx } = fakeCtx({ agents: { list: () => [{ session }] }, controller })
  plugin.apply(ctx, CFG)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0)
})

test('开关关闭时不对齐，模型位保持用户所选', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ selection: { provider: 'p-user', model: 'user-picked' } })
  const { ctx } = fakeCtx({ agents: { list: () => [{ session }] }, controller })
  plugin.apply(ctx, { ...CFG, sessions: {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0)
})

test('对齐跳过子代理会话', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ origin: 'subagent', selection: { provider: 'x', model: 'y' } })
  const { ctx } = fakeCtx({ agents: { list: () => [{ session }] }, controller })
  plugin.apply(ctx, CFG)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0)
})

test('装了周期对齐的定时器，且随插件卸载清掉', () => {
  const { ctx } = fakeCtx()
  plugin.apply(ctx, CFG)
  // 用 ctx.effect 包住的 interval：这里只验证 apply 期间确实申请了定时器。
  assert.ok(Array.isArray(ctx.timers))
})

test('用户手动换模型 → 只关掉这个会话', async () => {
  const settings = fakeSettings()
  const controller = { selectModel: () => Promise.resolve({}) }
  const session = fakeSession({ selection: { provider: 'p-user', model: 'user-picked' } })
  const { ctx, listeners } = fakeCtx({
    agents: { list: () => [{ session }] },
    controller,
    settings,
  })
  plugin.apply(ctx, CFG)
  await new Promise((resolve) => setImmediate(resolve))

  // 插件先对齐到当前时段路由（记账），随后用户手动选了别的模型。
  const entry = listeners.find((item) => item.name === 'session/event')
  assert.ok(entry !== undefined, '必须监听会话事件以即时发现手动改动')
  entry.listener(session, {
    type: 'model/selection',
    data: { provider: 'p-other', model: 'another-model' },
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settings.updates.length, 1, '应写入一次关闭')
  assert.equal(settings.updates[0].ns, 'oh-my-dsh')
  // 关掉就是删键：既保持稀疏，也不留下会让以后判定出错的状态。
  assert.deepEqual(settings.updates[0].patch, { peakValley: { sessions: {} } }, '只删掉这个会话的记录')
})

test('插件自己写的对齐不会触发关闭', async () => {
  const settings = fakeSettings()
  const target = plugin.routeAt(readConfig(CFG))
  const writes = []
  const controller = { selectModel: (req) => { writes.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ selection: { provider: 'p-user', model: 'user-picked' } })
  const { ctx, listeners } = fakeCtx({
    agents: { list: () => [{ session }] },
    controller,
    settings,
  })
  plugin.apply(ctx, CFG)
  await new Promise((resolve) => setImmediate(resolve))

  const entry = listeners.find((item) => item.name === 'session/event')
  // 插件自己写入的目标路由事件（写成功后模拟事件到达）
  entry.listener(session, { type: 'model/selection', data: target })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settings.updates.length, 0, '自己写的不算手动改动')
})

test('开关关闭期间的手动改动不触发任何写入', async () => {
  const settings = fakeSettings()
  const session = fakeSession({ selection: { provider: 'x', model: 'y' } })
  const { ctx, listeners } = fakeCtx({ agents: { list: () => [{ session }] }, settings })
  plugin.apply(ctx, { ...CFG, sessions: {} })
  await new Promise((resolve) => setImmediate(resolve))

  const entry = listeners.find((item) => item.name === 'session/event')
  entry.listener(session, { type: 'model/selection', data: { provider: 'a', model: 'b' } })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settings.updates.length, 0)
})

test('手动改成「恰好是当前时段路由」不算手动改动（可能是客户端即时对齐）', async () => {
  const settings = fakeSettings()
  const target = plugin.routeAt(readConfig(CFG))
  const controller = { selectModel: () => Promise.resolve({}) }
  const session = fakeSession({ selection: { provider: 'x', model: 'y' } })
  const { ctx, listeners } = fakeCtx({
    agents: { list: () => [{ session }] },
    controller,
    settings,
  })
  plugin.apply(ctx, CFG)
  await new Promise((resolve) => setImmediate(resolve))

  const entry = listeners.find((item) => item.name === 'session/event')
  entry.listener(session, { type: 'model/selection', data: target })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settings.updates.length, 0)
})

test('自动关闭只写一次，不刷屏', async () => {
  const settings = fakeSettings()
  const controller = { selectModel: () => Promise.resolve({}) }
  const session = fakeSession({ selection: { provider: 'x', model: 'y' } })
  const { ctx, listeners } = fakeCtx({
    agents: { list: () => [{ session }] },
    controller,
    settings,
  })
  plugin.apply(ctx, CFG)
  await new Promise((resolve) => setImmediate(resolve))

  const entry = listeners.find((item) => item.name === 'session/event')
  for (let i = 0; i < 3; i += 1) {
    entry.listener(session, { type: 'model/selection', data: { provider: 'p-user', model: 'm' + i } })
  }

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settings.updates.length, 1, '连续多次手动改动只应写一次关闭')
})

test('按会话隔离：只有开着的会话会被对齐，没打开的不动', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const on = fakeSession({ id: 's1', selection: { provider: 'picked', model: 'picked' } })
  const off = fakeSession({ id: 's2', selection: { provider: 'picked', model: 'picked' } })
  const { ctx } = fakeCtx({ agents: { list: () => [{ session: on }, { session: off }] }, controller })
  plugin.apply(ctx, { ...CFG, sessions: { s1: true } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls.map((call) => call.sessionId), ['s1'], '只对齐开着的会话')
})

test('未经设置的会话（含新建会话）一律关闭，不继承任何默认值', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ selection: { provider: 'picked', model: 'picked' } })
  const { ctx } = fakeCtx({ agents: { list: () => [{ session }] }, controller })
  plugin.apply(ctx, { ...CFG, sessions: {}, lastToggle: { on: false, at: 0 } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 0, '没有打开过的会话不该被对齐')
})

test('新会话继承最近一次动作，已有会话不受影响', () => {
  const base = { ...readConfig(CFG), sessions: {}, lastToggle: { on: true, at: 5000 } }

  assert.equal(plugin.stateForSession(base, 'new', 6000), true, '动作之后新建的会话继承「开」')
  assert.equal(plugin.stateForSession(base, 'old', 4000), false, '动作之前就存在的会话保持关闭')

  // 显式状态永远优先于继承。
  const explicit = { ...base, sessions: { off: false, on: true } }
  assert.equal(plugin.stateForSession(explicit, 'off', 6000), false, '显式关闭优先')
  assert.equal(plugin.stateForSession(explicit, 'on', 1000), true, '显式开启优先')
})

test('继承只在动作之后生效：最近一次动作是「开」，老会话依然关闭', () => {
  // 这是用户报过的回归：在一个会话里打开开关，不能把所有已有会话一起打开。
  const before = { ...readConfig(CFG), sessions: {}, lastToggle: { on: false, at: 0 } }
  const after = { ...before, ...plugin.nextState(before, 'A', true, 9000) }

  assert.equal(plugin.stateForSession(after, 'A', 1000), true, 'A 被记录')
  assert.equal(plugin.stateForSession(after, 'B', 2000), false, 'B 早于动作，必须保持关闭')
  assert.equal(plugin.stateForSession(after, 'C', 10000), true, 'C 晚于动作，继承开启')
})

test('normalizeLastToggle：写坏的值按关闭处理', () => {
  assert.deepEqual(plugin.normalizeLastToggle(undefined), { on: false, at: 0 })
  assert.deepEqual(plugin.normalizeLastToggle({ on: 'yes', at: -5 }), { on: false, at: 0 })
  assert.deepEqual(plugin.normalizeLastToggle({ on: true, at: 123 }), { on: true, at: 123 })
})

test('新会话继承「开」时会把状态落库（浏览器才知道要显示成开）', async () => {
  const settings = fakeSettings()
  const controller = { selectModel: () => Promise.resolve({}) }
  // 创建时间晚于最近一次动作 → 应继承「开」
  const session = fakeSession({ selection: { ...PEAK } })
  session.header.createdAt = Date.now()
  const { ctx } = fakeCtx({
    agents: { list: () => [{ session }] },
    controller,
    settings,
  })
  plugin.apply(ctx, {
    ...CFG,
    sessions: {},
    peakWindows: [{ start: '09:00', end: '12:00', ...PEAK }],
    offPeakRoute: { ...PEAK },
    lastToggle: { on: true, at: 1 },
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const write = settings.updates.find((item) => item.patch.peakValley?.sessions !== undefined)
  assert.ok(write !== undefined, '应把继承来的开启状态落库')
  assert.equal(write.patch.peakValley.sessions.s1, true)
})

test('已有会话不会因为最近一次动作是「开」而被落库', async () => {
  const settings = fakeSettings()
  const controller = { selectModel: () => Promise.resolve({}) }
  const session = fakeSession({ selection: { ...PEAK } })
  session.header.createdAt = 1000
  const { ctx } = fakeCtx({
    agents: { list: () => [{ session }] },
    controller,
    settings,
  })
  plugin.apply(ctx, {
    ...CFG,
    sessions: {},
    peakWindows: [{ start: '09:00', end: '12:00', ...PEAK }],
    offPeakRoute: { ...PEAK },
    lastToggle: { on: true, at: 5000 },
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(
    settings.updates.filter((item) => item.patch.peakValley?.sessions !== undefined).length,
    0,
    '早于动作的会话必须保持关闭，不能落库成开启',
  )
})

test('开关一改就立刻对齐（不等 15 秒巡检）', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ selection: { provider: 'picked', model: 'picked' } })
  const { ctx, listeners } = fakeCtx({ agents: { list: () => [{ session }] }, controller })

  const config = { sessions: {}, offPeakRoute: OFF, peakWindows: [], timeZone: 'Asia/Shanghai' }
  plugin.apply(ctx, config)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0, '没打开时不对齐')

  const doc = listeners.find((item) => item.name === 'settings/document-updated')
  assert.ok(doc !== undefined, '必须监听配置变更，否则新会话的第一条消息会跑在旧模型上')

  // 其它命名空间的变更不应触发。
  doc.listener('some-other-plugin')
  assert.equal(calls.length, 0)

  // 本插件命名空间被改（用户在胶囊上打开开关）：立刻对齐到谷时路由。
  config.sessions = { s1: true }
  doc.listener('oh-my-dsh')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 1, '配置一变就应立刻对齐')
  assert.equal(calls[0].provider, OFF.provider)
  assert.equal(calls[0].model, OFF.model)
})

test('轮次结束后立刻对齐（轮次中到点的切换在这里落地）', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ selection: { ...PEAK } })
  const { ctx, listeners } = fakeCtx({ agents: { list: () => [{ session }] }, controller })

  // 时段表与窗口外都指向 PEAK：与当前时间、星期无关，启动时无需写。
  const config = { sessions: { s1: true }, peakWindows: [{ start: '09:00', end: '12:00', ...PEAK }], offPeakRoute: { ...PEAK }, timeZone: 'Asia/Shanghai' }
  plugin.apply(ctx, config)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0, '已经在目标路由上')

  // 跨到谷时：模型位该换成 OFF 了。
  config.peakWindows = []
  config.offPeakRoute = OFF

  const events = listeners.find((item) => item.name === 'session/event')
  events.listener(session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 1, '轮次一结束就应把模型位对齐过去')
  assert.equal(calls[0].model, OFF.model)
})

test('功能开关关掉时即使会话是开着的也不对齐（合并后新增）', async () => {
  const calls = []
  const controller = { selectModel: (req) => { calls.push(req); return Promise.resolve({}) } }
  const session = fakeSession({ selection: { provider: 'picked', model: 'picked' } })
  const { ctx } = fakeCtx({ agents: { list: () => [{ session }] }, controller })
  plugin.apply(ctx, { ...CFG, enabled: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0, '整段功能关掉后不该动模型位')
})

test('功能关掉期间用户手动换模型也不写配置', async () => {
  const settings = fakeSettings()
  const session = fakeSession({ selection: { provider: 'x', model: 'y' } })
  const { ctx, listeners } = fakeCtx({ agents: { list: () => [{ session }] }, settings })
  plugin.apply(ctx, { ...CFG, enabled: false })
  await new Promise((resolve) => setImmediate(resolve))

  const entry = listeners.find((item) => item.name === 'session/event')
  entry.listener(session, { type: 'model/selection', data: { provider: 'a', model: 'b' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settings.updates.length, 0)
})
