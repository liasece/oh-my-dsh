/**
 * 提示词候选的宿主半边：浏览器请求 `ohMyDsh.candidates({ sessionId })`。
 *
 * 原 dsh-prompt-candidates 的实现，并入 oh-my-dsh 后只换了两处接缝：
 *   - 配置从整份 `config` 换成 `config.candidates` 这一段（字段与语义不变）；
 *   - `apply` 搬进合并后的 Typert 服务（见 `lib/service.js`），这里只留生成逻辑。
 *
 * 生成路线与能力都沿用会话自己发出的最后一次请求头：同一 provider／model，
 * 只把输出上限换成候选所需的小额度。历史取最近若干条纯文本用户／助手消息，
 * 末尾追加一条要求 JSON 输出的指令。整个过程不写会话日志，模型永远看不到
 * 这次候选请求。
 *
 * `enabled`、`maxSuggestions`、`historyMessages` 是 volatile 字段：宿主设置只投影这些
 * 字段，浏览器侧设置页写入后运行中的插件立即读到新值，无需重启。
 */
import { importShipped } from '../shipped.js'
import { PURPOSE, SYSTEM_PROMPT, buildInstruction, collectHistory, parseCandidates, textOf } from './candidates.js'

const [{ default: Schema }] = await Promise.all([importShipped('@deepseek-ai/schemastery')])

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile()
    .description('每回合结束后是否请求候选。'),
  maxSuggestions: Schema.natural().min(1).max(5).default(2).volatile()
    .description('一次最多给出几条候选；模型可以更少，但不能超过这个数。'),
  historyMessages: Schema.natural().min(1).max(40).default(12).volatile()
    .description('送给模型的最近消息条数（用户与助手消息各算一条）；最近的用户消息总会带上。'),
  maxOutputTokens: Schema.natural().min(32).default(1600)
    .description('这次候选请求的输出 token 上限；推理模型的思考过程也算在里面，留足余量。'),
  timeoutMs: Schema.natural().min(1000).default(25000)
    .description('一次候选请求的端到端时限。'),
  provider: Schema.string()
    .description('可选的路线覆盖；与 model 一起设置时才生效。'),
  model: Schema.string()
    .description('可选的路线覆盖；与 provider 一起设置时才生效。'),
  debug: Schema.boolean().default(false)
    .description('把每次候选请求的用量与原始输出打印到 Host 终端。'),
})

/** 读取 volatile 字段：到达时是活引用，而不是普通值。 */
const live = value => (typeof value?.get === 'function' ? value.get() : value)

/** 设置页可以写入任意整数，生成前再夹到schema允许的范围内，坏值不会让这一轮失效。 */
const between = (value, low, high, fallback) => {
  const number = Math.trunc(Number(live(value)))
  return Number.isFinite(number) && number >= low && number <= high ? number : fallback
}

/** 空结果：没有候选，并带上抑制原因。 */
const none = reason => ({ suggestions: [], reason })

/**
 * 把流终止原因压成一行可诊断文本：失败时带上错误码与截短的消息。
 * @param finish - `finish` 分片的 reason。
 * @returns 供 Client 打印的原因。
 */
function describeFinish(finish) {
  const failure = finish.failure
  if (failure === undefined) return `finish-${finish.kind}`
  const code = failure.code === undefined ? '' : `:${failure.code}`
  const status = failure.status === undefined ? '' : `:${failure.status}`
  const message = typeof failure.message === 'string' ? `:${failure.message.slice(0, 200)}` : ''
  return `finish-${finish.kind}${code}${status}${message}`
}

/** 等一个 Promise，但调用方中止时立即放弃等待；共享的生成仍在继续。 */
function untilAborted(promise, signal) {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * 从刚结束一个回合的会话生成候选。
 * @param ctx - 暴露 `llm` 的上下文。
 * @param config - 已解析的插件配置。
 * @param session - 活动会话。
 * @param signal - 本次生成的取消信号。
 */
export async function generateCandidates(ctx, section, session, signal) {
  const messages = session.deriveMessages()
  const last = messages.at(-1)
  if (last === undefined || last.role !== 'assistant') return none('not-at-turn-end')
  if (last.content.some(block => block.type === 'tool-call')) return none('not-at-turn-end')
  if (textOf(last) === '') return none('no-assistant-text')

  const header = session.requestHeader()
  if (header === undefined) return none('no-request-header')

  // 设置页随时可能改这两项：每次生成都重新读一遍活引用。
  const max = between(section.maxSuggestions, 1, 5, 2)
  const override = section.provider && section.model ? { provider: section.provider, model: section.model } : undefined
  const proposal = override === undefined
    ? { ...header.config, maxTokens: section.maxOutputTokens }
    : { ...override, maxTokens: section.maxOutputTokens }

  // 助手消息要带 source（含 provider／model），否则适配器读重放状态时会报错。
  const recent = between(section.historyMessages, 1, 40, 12)
  const history = collectHistory(messages, recent, { provider: proposal.provider, model: proposal.model })
  if (!history.some(message => message.role === 'user')) return none('no-user-message')

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(section.timeoutMs)])
  const call = await ctx.llm.prepareCall(proposal, deadline, (controls, info) => {
    const least = info?.reasoning?.efforts?.[0]?.id
    return { ...controls, maxTokens: section.maxOutputTokens, ...(least === undefined ? {} : { reasoningEffort: least }) }
  })

  const options = {
    ...call.config,
    messages: [...history, buildInstruction(max)],
    system: SYSTEM_PROMPT,
    sessionId: session.id,
    purpose: PURPOSE,
    signal: deadline,
  }

  let text = ''
  let finish
  for await (const chunk of call.stream(options)) {
    deadline.throwIfAborted()
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'tool-call-delta') return none('tool-call')
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (section.debug) console.error('[dsh-prompt-candidates] raw', JSON.stringify(text))
  if (finish !== undefined && finish.kind !== 'stop') return none(describeFinish(finish))

  const suggestions = parseCandidates(text, max)
  if (suggestions.length === 0) return none('no-candidates')
  ctx.logger.info('candidates: %d', suggestions.length)
  return { suggestions, reason: 'ok' }
}

/** 本功能是否启用：缺省视为启用。 */
export const enabled = section => live(section?.enabled) !== false

/**
 * 每个会话至多一次在途或已完成的生成，按它所依据的日志长度作键。
 *
 * 同一个回合里浏览器重复请求只等同一份结果；进入新一轮（seq 变化）时取消旧的，
 * 免得旧回合的候选在界面上闪一下。
 *
 * @param ctx 宿主上下文。
 * @param section 配置里的 `candidates` 段。
 * @returns 读取与清理接口。
 */
export function createCandidateCache(ctx, section) {
  const latest = new Map()
  return {
    /** 关掉功能时丢弃所有在途生成。 */
    abortAll() {
      for (const entry of latest.values()) entry.controller.abort()
      latest.clear()
    },
    /**
     * 取这个会话当前的候选（必要时新开一次生成）。
     * @param session 活动会话。
     * @param signal 调用方取消；只停止这次等待，不停止共享的生成。
     */
    get(session, signal) {
      const key = session.seq
      let entry = latest.get(session.id)
      if (entry === undefined || entry.key !== key) {
        entry?.controller.abort()
        const controller = new AbortController()
        entry = {
          key,
          controller,
          promise: generateCandidates(ctx, section, session, controller.signal).catch(error => {
            ctx.logger.warn('candidates failed: %s', error?.message ?? error)
            return none(controller.signal.aborted ? 'aborted' : 'error')
          }),
        }
        latest.set(session.id, entry)
      }
      return untilAborted(entry.promise, signal)
    },
  }
}
