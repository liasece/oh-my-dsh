/**
 * 峰谷动态：按 DeepSeek 官方峰谷时段，把请求路由到两条真实路由。
 *
 * 原 dsh-peak-valley-model 的宿主半边，并入 oh-my-dsh 后只换了两处接缝：
 *   - 配置从插件的整份 `config` 换成 `config.peakValley` 这一段（字段与语义不变）；
 *   - 增加 `enabled` 开关：关掉时所有回调都空转，但监听仍挂着，所以设置页
 *     打开后立刻生效，不需要重载插件。
 *
 * v0.6 的约定：**插件不再是模型**。模型列表里只有真实模型，
 * 「峰谷动态」不占一个条目。插件只做两件事：
 *
 *   1. 提供开关（配置里的 `sessions`，浏览器侧通过设置表单读写）；
 *   2. 某个会话打开开关时，把它的**模型选择**换成当前时段的真实路由。
 *
 * 开关是**按会话**的，且没有「默认开启」：没打开过的会话一律不介入。插件不会
 * 替你决定哪些会话要改路由 —— 会话选了哪个模型与开没开无关，模型菜单里也不会
 * 出现第二个开关。
 *
 * 为什么改模型位而不是拦请求：dsh-agent 在 `preStep` 里就按 `model.current()`
 * 定死了这一步的 provider/model，之后 `agent/request` 只允许原样透传 —— 改了就报
 * 「agent/request proposed X after step preparation fixed Y」。
 *
 * 所以路由的唯一入口是**步前的模型位**（`sessionController.selectModel`）。
 * 由此带来的约束：模型位只在轮次之间写。轮次中途换路由会把别的路由产出的
 * tool_use 消息重放过去，服务端的 thinking 签名不可移植，直接 400。
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_TIME_ZONE, formatClock } from './period.js'
import { periodInfo, routeAt } from './state.js'

export { periodInfo, routeAt }

/** 一个真实上游路由。 */
const routeField = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
})

/** 一个时段：`HH:MM` 区间 + 该区间使用的模型。 */
const windowField = Schema.object({
  /** 起始 `HH:MM`；等于 end 表示空区间，会被忽略。 */
  start: Schema.string().default('09:00'),
  /** 结束 `HH:MM`，左闭右开；早于 start 表示跨零点。 */
  end: Schema.string().default('12:00'),
  provider: Schema.string().required(),
  model: Schema.string().required(),
})

/** 一条可以直接用的默认路由：桌面端账号登录的官方 Flash。 */
const DEFAULT_ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * 插件配置。
 *
 * 三个字段都声明为 `volatile`：`settings.describe()` 只投影 volatile 字段，
 * 也只有 volatile 字段能被浏览器写入并且**不重载插件**即时生效。
 */
export const Config = Schema.object({
  /** 功能开关：关掉后不再改动任何会话的模型位。 */
  enabled: Schema.boolean().default(true).volatile()
    .description('是否启用峰谷动态；关掉后不再改动任何会话的模型位。'),
  /** 参考时区；峰谷价按官方北京时间定义，一般不需要改。 */
  timeZone: Schema.string().default(DEFAULT_TIME_ZONE).volatile(),
  /** 未命中任何时段时使用的真实路由（默认是谷时/半价那条）。 */
  offPeakRoute: routeField.default({ ...DEFAULT_ROUTE }).volatile(),
  /**
   * 时段表：每个区间带上它自己的模型。
   *
   * 默认沿用官方定义（工作日 09:00–12:00 与 14:00–18:00 走峰时路由），
   * 周末整天走 `offPeakRoute`。设置页可增删改。
   */
  peakWindows: Schema.array(windowField).default([
    { start: '09:00', end: '12:00', ...DEFAULT_ROUTE },
    { start: '14:00', end: '18:00', ...DEFAULT_ROUTE },
  ]).volatile(),
  /**
   * 开着峰谷动态的会话。
   *
   * 只有显式打开过的会话才会出现在这里；关掉即删键，所以这张表始终是稀疏的。
   * **不存在「默认开启」**：没有记录的会话一律视为关闭 —— 插件不会替你决定
   * 哪些会话要改路由。
   */
  sessions: Schema.dict(Schema.boolean()).default({}).volatile(),
  /**
   * 最近一次切换开关的状态，用来给**之后新建的会话**定初始状态。
   *
   * 为什么要带时间戳：只记一个布尔值的话，就分不清「这次动作之前就存在、只是
   * 从没碰过开关的会话」和「动作之后新建的会话」，于是改一次就把所有已有会话
   * 一起翻掉 —— 这正是 v0.9 的 bug。`at` 让判定有边界：只有创建时间不早于
   * `at` 的会话才继承这个状态。
   */
  lastToggle: Schema.object({
    on: Schema.boolean().default(false),
    at: Schema.number().default(0),
  }).default({ on: false, at: 0 }).volatile(),
})

/** 默认值，供配置缺席时兜底。 */
const DEFAULTS = {
  enabled: true,
  sessions: {},
  lastToggle: { on: false, at: 0 },
  timeZone: DEFAULT_TIME_ZONE,
  offPeakRoute: { ...DEFAULT_ROUTE },
  peakWindows: [
    { start: '09:00', end: '12:00', ...DEFAULT_ROUTE },
    { start: '14:00', end: '18:00', ...DEFAULT_ROUTE },
  ],
}

/**
 * 从 `apply` 收到的配置里读一个字段。
 *
 * cordis 在调用 `apply` 之前已经用本文件的 `Config` 校验过一次，所以这里拿到
 * 的是**解析结果**：volatile 字段是引用对象（带 `get()`），普通字段是值。
 * 因此绝不能再次 `Config(config)` —— 那等于拿引用对象重做校验，会报
 * `$.enabled.… missing required value` 之类，插件直接加载失败。
 *
 * 每次调用都重新读引用对象，所以设置页写入后立刻生效，不需要重启。
 */
export function readConfig(section) {
  const read = (field) => {
    const value = section?.[field]
    if (value === undefined) return DEFAULTS[field]
    return typeof value.get === 'function' ? value.get() : value
  }
  const sessions = read('sessions')
  const windows = read('peakWindows')
  const lastToggle = read('lastToggle')
  return {
    enabled: read('enabled') !== false,
    sessions: sessions !== null && typeof sessions === 'object' ? { ...sessions } : {},
    lastToggle: normalizeLastToggle(lastToggle),
    timeZone: read('timeZone') ?? DEFAULTS.timeZone,
    offPeakRoute: read('offPeakRoute') ?? DEFAULTS.offPeakRoute,
    peakWindows: Array.isArray(windows) ? windows : DEFAULTS.peakWindows,
  }
}

/**
 * 规范化「最近一次动作」。写坏的值按「关闭、无时间」处理，不让一份手改的配置
 * 把插件判成意外状态。
 * @param raw 配置里的原始值。
 */
export function normalizeLastToggle(raw) {
  if (raw === null || typeof raw !== 'object') return { on: false, at: 0 }
  const at = Number(raw.at)
  return {
    on: raw.on === true,
    at: Number.isFinite(at) && at > 0 ? at : 0,
  }
}

/**
 * 某个会话此刻是否启用峰谷动态。
 *
 * 判定顺序：
 *  1. 有显式状态（用户在这个会话上点过开关）→ 用它；
 *  2. 会话创建时间不早于最近一次动作 → 用那次动作的状态（新会话继承）；
 *  3. 其余一律关闭。
 *
 * 第 2 条的 `at` 边界是关键：少了它，一次切换就会把所有没记录过状态的已有会话
 * 一起翻掉。现在只有「动作之后新建的会话」会继承。
 *
 * @param cfg readConfig 的结果。
 * @param sessionId 会话 id。
 * @param createdAt 会话创建时间（毫秒）；拿不到时按「已有会话」处理。
 */
export function stateForSession(cfg, sessionId, createdAt) {
  if (sessionId === undefined) return false
  if (Object.hasOwn(cfg.sessions, sessionId)) return cfg.sessions[sessionId] === true
  const toggle = cfg.lastToggle ?? { on: false, at: 0 }
  if (toggle.at === 0 || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return false
  return createdAt >= toggle.at ? toggle.on : false
}

/**
 * 算出「把某个会话设为 on，并记下这是最近一次动作」之后的配置。
 *
 * 关掉即删键，保持 `sessions` 稀疏；`lastToggle` 同时更新状态与时间。
 *
 * @param cfg readConfig 的结果。
 * @param sessionId 要改的会话。
 * @param on 目标状态。
 * @param now 动作时间（毫秒），便于测试；客户端写配置时用本地时间。
 */
export function nextState(cfg, sessionId, on, now = Date.now()) {
  const sessions = { ...cfg.sessions }
  if (sessionId !== undefined) {
    if (on) sessions[sessionId] = true
    else delete sessions[sessionId]
  }
  const lastToggle = sessionId === undefined
    ? (cfg.lastToggle ?? { on: false, at: 0 })
    : { on, at: now }
  return { sessions, lastToggle }
}

/**
 * 读取会话的创建时间（毫秒）。
 * @param session 会话对象。
 */
export function createdAtOf(session) {
  const value = session?.header?.createdAt
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 子代理会话不参与：它们跟随父代理。 */
function isSubagent(agent) {
  return agent?.session?.header?.origin === 'subagent'
}

/** 两份选择是否同一条路由。 */
function sameRoute(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && a.provider === b.provider && a.model === b.model
}

/**
 * 读会话此刻"想要用的"选择。
 *
 * 与会话投影同一口径：最近一条 model/selection 与最近一次请求头不一致时，
 * 说明用户刚选过还没生效（pending），应取前者；否则取请求头。
 */
export function intendedSelection(session) {
  const events = session.snapshotEvents()
  let pending
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'model/selection') { pending = events[i].data; break }
  }
  const header = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined
  const used = header === undefined ? undefined : { provider: header.provider, model: header.model }
  if (pending !== undefined && !sameRoute(pending, used)) return pending
  return used ?? pending
}

/** 对齐间隔：跨时段后模型位最多延迟这么久更新（请求本身不受影响）。 */
const ALIGN_INTERVAL_MS = 15000

export function apply(ctx, section) {
  /**
   * 把会话的模型选择对齐到当前时段的真实路由。
   *
   * 这是**唯一**的路由手段：`preStep` 用 `model.current()` 决定这一步用哪个
   * provider/model，`agent/request` 再改就会被拒绝。
   *
   * 走 `sessionController.selectModel`：它同时设置运行中代理的 picked 选择并
   * 写入 model/selection。只 append 事件不会改变实际去向。
   */
  /**
   * 记录「本插件给某个会话写下的路由」。
   *
   * 用来区分两种改动：我们自己写的对齐，和用户手动换的模型。后者一旦发生，
   * 说明用户想自己拿回模型控制权，就不再拉回，改为把开关关掉。
   */
  const aligned = new Map()
  /** 正在写入的目标路由。写入会触发 model/selection，先记账才不会被当成手动改动。 */
  const pending = new Map()

  /** 合并后整个插件共用一个条目 id，也就是设置命名空间。 */
  const entryId = ctx.fiber?.entry?.options?.id ?? 'oh-my-dsh'

  /**
   * 只把「这一个会话」的峰谷动态关掉。
   *
   * 用户手动换模型表达的是「这个会话我想自己控制」，不该波及其他会话 ——
   * 所以这里只删掉这一个会话的记录。
   */
  const closing = new Set()
  const switchOffSession = (sessionId, reason) => {
    if (closing.has(sessionId)) return
    closing.add(sessionId)
    aligned.delete(sessionId)
    pending.delete(sessionId)
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.update !== 'function') {
      ctx.logger?.debug?.('peak-valley: 没有 settings 服务，无法自动关闭: ' + reason)
      closing.delete(sessionId)
      return
    }
    const cfg = readConfig(section)
    if (!Object.hasOwn(cfg.sessions, sessionId)) {
      // 本来就没开，不需要写配置。
      closing.delete(sessionId)
      return
    }
    const { sessions } = nextState(cfg, sessionId, false)
    Promise.resolve(settings.update(entryId, { peakValley: { sessions } }))
      .then(() => {
        ctx.logger?.debug?.('peak-valley: 已关闭该会话（' + reason + '）')
      })
      .catch((error) => {
        ctx.logger?.warn?.('peak-valley: 自动关闭失败: ' + String(error))
        closing.delete(sessionId)
      })
  }

  const align = (agent) => {
    const session = agent?.session
    if (session === undefined || isSubagent(agent)) return false
    const controller = ctx.get('sessionController')
    if (controller === undefined || typeof controller.selectModel !== 'function') return false
    let intent
    try {
      intent = intendedSelection(session)
    } catch (error) {
      ctx.logger?.debug?.('peak-valley: 读取会话选择失败: ' + String(error))
      return false
    }
    if (intent === undefined) return false

    // 上轮由我们写到这个会话上的路由；对不上就说明是用户手动换的。
    const expected = aligned.get(session.id)
    if (expected !== undefined && !sameRoute(intent, expected)) {
      switchOffSession(session.id, `模型被手动改成 ${intent.provider}/${intent.model}`)
      return false
    }

    const target = routeAt(readConfig(section))
    if (sameRoute(intent, target)) {
      aligned.set(session.id, target)
      return false
    }
    pending.set(session.id, target)
    return Promise.resolve(
      controller.selectModel({ sessionId: session.id, provider: target.provider, model: target.model }),
    ).then(
      () => {
        // 写成功之后再转正：写之前 intent 还是旧值，提前记账会被误判成手动改动。
        pending.delete(session.id)
        aligned.set(session.id, target)
        return true
      },
      (error) => {
        pending.delete(session.id)
        ctx.logger?.debug?.('peak-valley: 对齐模型位失败: ' + String(error))
        return false
      },
    )
  }

  /** 把所有「已启用峰会动态」的在线会话对齐到当前时段。 */
  const alignAll = () => {
    if (!readConfig(section).enabled) return
    const cfg = readConfig(section)
    const agents = ctx.get('agents')
    if (agents === undefined) return
    for (const agent of agents.list()) {
      const sessionId = agent?.session?.id
      if (sessionId === undefined) continue
      // 新会话继承「最近一次动作」时，把状态落成显式条目：浏览器侧拿不到
      // 创建时间，只能按 sessions[id] 显示，不落库开关会显示成关闭。
      materialize(agent?.session)
      // 轮次进行中不动模型位：等这一轮结束再对齐。
      if (runningTurns.has(sessionId)) continue
      if (!stateForSession(readConfig(section), sessionId, createdAtOf(agent?.session))) {
        // 该会话没启用：清掉它自己的记账，免得重新启用时把旧记录误判成手动改动。
        aligned.delete(sessionId)
        pending.delete(sessionId)
        closing.delete(sessionId)
        continue
      }
      try {
        align(agent)
      } catch (error) {
        ctx.logger?.debug?.('peak-valley: 对齐巡检失败: ' + String(error))
      }
    }
  }

  /**
   * 尽快对齐一遍（合并同一轮里的多次请求）。
   *
   * 开关刚被切换时用它：不这样的话，用户新开会话、打开开关、立刻发消息，
   * 第一条消息会跑在旧模型上（巡检最长 15 秒）。
   *
   * 放到微任务里执行：它可能在配置事件的派发过程中触发，而「落库」又会写配置，
   * 同步重入 settings 的收集流程不安全。
   */
  let alignScheduled = false
  const alignSoon = () => {
    if (alignScheduled) return
    alignScheduled = true
    Promise.resolve().then(() => {
      alignScheduled = false
      alignAll()
    })
  }

  /**
   * 配置被改（开关、时段表、时区）后立刻对齐。
   *
   * 插件自己的落库也会触发这个事件，但 align 是幂等的：已经在目标路由上
   * 就不会再写，所以不会自激。
   */
  ctx.on('settings/document-updated', (ns) => {
    if (ns !== entryId) return
    alignSoon()
  })

  /**
   * 即时发现「用户手动换了模型」。
   *
   * 巡检 15 秒才跑一次，这段窗口里请求仍会被改写到峰谷路由；监听会话事件可以
   * 做到立刻收手。判定只看一件事：新选择既不是我们刚写下的、也不是正在写的，
   * 就说明是用户自己动手选的。
   */
  /** 正在落库的会话：避免同一会话重复写。 */
  const materializing = new Set()
  /** 落库串行化：两次写入并发时后一次基于前一次的结果，不会互相覆盖。 */
  let materializeQueue = Promise.resolve()

  /**
   * 把「新会话继承来的开启状态」落成显式条目。
   *
   * 为什么必须落库：浏览器侧没有会话创建时间（`sessionListMetadata` 只有
   * `blank`/`lastPromptAt`），开关只能按 `sessions[sessionId]` 显示。宿主知道
   * 创建时间，算得出该不该继承，就把结果写下来，两边才对得上。
   *
   * 只在结果为「开」时写：关闭本来就是默认值，写它只会平白增加配置噪音。
   * @param session 会话对象。
   */
  const materialize = (session) => {
    const sessionId = session?.id
    if (sessionId === undefined || materializing.has(sessionId)) return
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.update !== 'function') return
    const cfg = readConfig(section)
    if (Object.hasOwn(cfg.sessions, sessionId)) return
    if (!stateForSession(cfg, sessionId, createdAtOf(session))) return
    materializing.add(sessionId)
    materializeQueue = materializeQueue
      .then(() => {
        // 排队期间配置可能又被改过，落库前再确认一次。
        const latest = readConfig(section)
        if (Object.hasOwn(latest.sessions, sessionId)) return undefined
        return settings.update(entryId, { peakValley: { sessions: { ...latest.sessions, [sessionId]: true } } })
      })
      .then(() => {
        ctx.logger?.debug?.(`peak-valley: 新会话继承开启状态并落库 ${sessionId}`)
      })
      .catch((error) => {
        ctx.logger?.warn?.('peak-valley: 落库新会话状态失败: ' + String(error))
      })
      .finally(() => {
        materializing.delete(sessionId)
      })
  }

  /**
   * 正在跑轮次的会话。
   *
   * 轮次进行中不能改模型位：那会让下一次请求在工具循环中途换路由，把别的
   * 路由产出的 tool_use 消息重放过去，服务端直接 400（thinking 签名不可移植）。
   */
  const runningTurns = new Set()

  const watchManual = (session, event) => {
    if (!readConfig(section).enabled) return
    if (event?.type === 'turn/start' && session?.id !== undefined) {
      runningTurns.add(session.id)
      return
    }
    if (event?.type === 'turn/end' && session?.id !== undefined) {
      runningTurns.delete(session.id)
      // 轮次期间到点的切换在这里落地：模型位只能在轮次之间写。
      alignSoon()
      return
    }
    if (event?.type !== 'model/selection') return
    const cfg = readConfig(section)
    if (!stateForSession(cfg, session.id, createdAtOf(session))) return
    const next = event.data
    if (next === undefined || next === null) return
    const ourPending = pending.get(session.id)
    if (ourPending !== undefined && sameRoute(next, ourPending)) return
    // 与当前时段目标一致的选择永远不算手动改动：它既可能是本插件写的，
    // 也可能是客户端开启瞬间的即时对齐（那条路径没有 pending 记账）。
    if (sameRoute(next, routeAt(cfg))) return
    const ours = aligned.get(session.id)
    if (ours === undefined) return
    if (sameRoute(next, ours)) return
    switchOffSession(session.id, `模型被手动改成 ${next.provider}/${next.model}`)
  }

  ctx.on('session/event', watchManual)

  // 启动即对齐一次，之后按固定间隔跟进跨时段；开关关掉时这些动作都是空转。
  alignAll()
  ctx.effect(() => {
    const timer = setInterval(alignAll, ALIGN_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'peak-valley-model: model seat alignment')
}
