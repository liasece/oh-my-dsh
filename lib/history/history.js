/**
 * 输入历史的消息挑选。纯函数，不接触 Cordis 上下文，便于单独推理与测试。
 */

/**
 * 算作「用户真的发过」的消息来源。
 *
 * 框架注入的上下文（runtime-context、skill-catalog、time-context、压缩检查点等）也是
 * user 角色，但它们不是用户写下的输入；`agent-message` 是其他 Agent（例如可续聊的
 * 子会话）发进来的消息，同样不是用户自己敲的。这些都不进召回列表，否则会把用户
 * 真正发过的话挤掉，也会让 ↑ 召回出自己没写过的内容。
 */
const USER_SOURCES = new Set(['user'])

/** 默认最多返回多少条；调用方可以要求更少，但不能超过它。 */
export const DEFAULT_LIMIT = 50

/** 一次允许请求的最大条数，避免浏览器侧写错数字时让 Host 扫两遍消息。 */
export const MAX_LIMIT = 200

/**
 * 取一条消息里的纯文本；没有文本时返回空串。
 * @param message - `session.deriveMessages()` 里的一条消息。
 * @returns 拼接后的文本。
 */
export function textOf(message) {
  if (Array.isArray(message?.content) !== true) return ''
  let text = ''
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * 这条消息是不是用户写下的一句话。
 * @param message - 派生消息。
 * @returns 是用户亲手发来的消息时为真。
 */
export function isSentMessage(message) {
  if (message?.role !== 'user') return false
  const kind = message.source?.kind
  return typeof kind === 'string' && USER_SOURCES.has(kind)
}

/**
 * 从派生消息里取最近若干条用户消息的文本。
 *
 * 只需要文本：召回的是「上次说了什么」，不是重新发送一份带附件和引用的完整输入。
 * 空文本（纯图片／附件消息）跳过，因为它召回进输入框也发不出去。
 * @param messages - `session.deriveMessages()` 的结果。
 * @param limit - 最多返回多少条，越界时夹到 [1, MAX_LIMIT]。
 * @returns 按时间顺序排列的文本，最后一条是最近发送的那条。
 */
export function recentUserTexts(messages, limit) {
  const wanted = normalizeLimit(limit)
  const picked = []
  if (Array.isArray(messages) !== true) return picked
  for (let index = messages.length - 1; index >= 0 && picked.length < wanted; index -= 1) {
    const message = messages[index]
    if (!isSentMessage(message)) continue
    const text = textOf(message)
    if (text.trim() === '') continue
    picked.push(text)
  }
  return picked.reverse()
}

/**
 * 把外部传来的条数夹到合法范围。
 * @param limit - 调用方要求的条数，可能缺失或是坏值。
 * @returns [1, MAX_LIMIT] 之间的整数。
 */
export function normalizeLimit(limit) {
  const number = Math.trunc(Number(limit))
  if (!Number.isFinite(number) || number < 1) return DEFAULT_LIMIT
  return Math.min(number, MAX_LIMIT)
}
