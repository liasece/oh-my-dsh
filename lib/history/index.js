/**
 * 输入历史的宿主半边：浏览器请求 `ohMyDsh.history({ sessionId, limit })`。
 *
 * 历史来自会话日志（`session.deriveMessages()`），不是浏览器内存：刷新页面、
 * 换窗口、重开旧会话，召回到的内容都一致。
 *
 * 与原 dsh-prompt-history 相同，只是并进 oh-my-dsh 后配置从 `config.history`
 * 这一段读，并多了 `enabled` 开关。
 */
import Schema from '@deepseek-ai/schemastery'
import { recentUserTexts } from './history.js'

/** 默认一次往回翻多少条：与原 dsh-prompt-history 的运行值一致。 */
const DEFAULT_LIMIT = 100

/** 配置里的 `history` 段。 */
export const Config = Schema.object({
  /** 功能开关：关掉后 ↑ 交还给编辑器自己。 */
  enabled: Schema.boolean().default(true).volatile()
    .description('是否启用输入历史：草稿为空时按 ↑ 召回上一条发送过的消息。'),
  /** 一次最多往回翻多少条；只数用户亲手发送的消息。 */
  limit: Schema.natural().min(1).max(200).default(DEFAULT_LIMIT).volatile()
    .description('一次最多召回多少条用户自己发送的消息，取值 1–200；助手、子 Agent 与框架注入的消息不占条数。'),
})

/** 读取配置里的活引用。 */
const live = value => (typeof value?.get === 'function' ? value.get() : value)

/** 本功能是否启用：缺省视为启用。 */
export const enabled = section => live(section?.enabled) !== false

/**
 * 取这个会话的历史条数上限。
 * @param section 配置里的 `history` 段。
 * @returns 1–200 的整数。
 */
export function limitOf(section) {
  const value = Math.trunc(Number(live(section?.limit)))
  return Number.isFinite(value) && value >= 1 && value <= 200 ? value : DEFAULT_LIMIT
}

/**
 * 一个会话里用户亲手发送的消息文本，最早的一条在前。
 *
 * 会话已经不在活动列表里、或者派生消息失败时返回空列表：召回是锦上添花的功能，
 * 不该让一次按键变成报错。
 *
 * @param ctx 宿主上下文（需要 `sessions`）。
 * @param section 配置里的 `history` 段。
 * @param sessionId 会话 id。
 * @returns 用户亲手发送的消息文本，最早的一条在前。
 */
export function historyOf(ctx, section, sessionId) {
  if (!enabled(section)) return []
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) return []
  try {
    return recentUserTexts(session.deriveMessages(), limitOf(section))
  } catch (error) {
    ctx.logger?.warn?.('prompt-history: 读取会话消息失败: ' + String(error))
    return []
  }
}
