/**
 * 提示词构造与模型输出解析。纯函数，不接触 Cordis 上下文，便于单独推理。
 */

/** 辅助请求用途标记；适配器只把它当模型不可见的传输元数据。 */
export const PURPOSE = 'dsh-prompt-candidates'

/** 单条候选的字符上限；更长的输出视为模型没有遵守格式而丢弃。 */
export const MAX_CANDIDATE_CHARS = 1000

/**
 * 算作真实对话的消息来源：人类/其他 Agent 发出的用户消息，和模型自己的回复。
 * 框架注入的上下文（runtime-context、skill-catalog、compact-checkpoint 等）也是
 * user 角色，但它们不是对话内容，混进来只会挤掉真正的上下文。
 */
const CONVERSATION_KINDS = new Set(['user', 'agent-message', 'compact-checkpoint'])

/**
 * 自动压缩后的 checkpoint 仍然算对话：它就是把更早的对话压成的一份摘要。
 * 压缩刚发生时，除了它几乎没有别的真实消息，跳过它就等于没有上下文。
 */
const CHECKPOINT_CHARS = 12000

/**
 * 最近一条用户消息的保底字数。条数窗口和总预算都可能只装下助手的长回复，
 * 但对话锚点（用户到底问了什么）不能丢，否则模型无处可续。
 */
const ANCHOR_CHARS = 2000

/** 单条历史消息的字符上限，避免旧的长消息把请求撑大。 */
const MAX_HISTORY_MESSAGE_CHARS = 4000

/** 历史片段的总字符预算。 */
const MAX_HISTORY_TOTAL_CHARS = 24000

export const SYSTEM_PROMPT = [
  'You write the next user message that a developer is most likely to send in a coding-assistant conversation.',
  'Reply with one JSON object and nothing else: {"suggestions":["...","..."]}.',
  'Each suggestion is a complete, directly sendable user message. No numbering, no commentary, no markdown.',
  'Keep each suggestion to one or two sentences; no line breaks and no paragraphs.',
  'Answer with the JSON object only: no explanation, no reasoning, no preface.',
  'Use the same language as the latest user message in the conversation.',
].join('\n')

/**
 * 构造追加到历史之后的最后一条用户请求。
 * @param max - 候选数量上限。
 * @param language - 最近一条用户消息的语种提示（仅用于措辞）。
 * @returns 仅用于本次请求的 user 消息。
 */
export function buildInstruction(max, language) {
  const lines = [
    `请根据上面的对话，给出最多 ${max} 条我接下来最可能发送的消息候选，按可能性从高到低排列。`,
    '',
    '要求：',
    `- 最多 ${max} 条，宁少勿滥；每条都必须是能直接发送的完整用户消息。`,
    '- 不要编号、不要解释、不要加引号或 Markdown 包装。',
    '- 每条一到两句，控制在约 60 个汉字或 200 个字符以内；不要换行，不要分段。',
    '- 直接输出 JSON，不要写推理过程或解释。',
    `- 与对话语言保持一致${language === undefined ? '' : `（${language}）`}。`,
    '- 候选之间要有明确差异，覆盖不同的合理意图；不要重复对话里已经出现过的消息。',
    '- 只有确实无法从上下文推断时才返回空数组。',
    '',
    '只输出 JSON：{"suggestions":["候选一","候选二"]}',
  ]
  return { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }
}

/**
 * 这条消息是否属于真实对话（而不是框架注入的上下文）。
 * @param message - 派生消息。
 * @returns 用户/Agent 消息或模型回复为真。
 */
function isConversation(message) {
  const kind = message?.source?.kind
  if (typeof kind !== 'string') return false
  if (message.role === 'user') return CONVERSATION_KINDS.has(kind)
  return message.role === 'assistant' && kind === 'model'
}

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
 * 从派生消息里取最近若干条纯文本用户／助手消息，重建成仅本次请求使用的消息。
 *
 * 助手消息必须带 `source`：适配器会用 `source.replayState` 重放推理过程，
 * 缺了 `source` 会直接抛错。这里不给 `replayState`，模型就按没有推理历史处理。
 * 工具结果、附件和推理块一律不进入请求：候选只需要对话意图。
 * @param messages - `session.deriveMessages()` 的结果。
 * @param limit - 最多保留多少条消息。
 * @param route - 本会话的 provider／model，用于补全助手消息的 `source`。
 * @returns 按时间顺序排列的请求消息。
 */
/**
 * 按消息类型裁剪正文。checkpoint 保留尾部：摘要前面是目标与历史，尾部才是
 * 最近的状态，对「接下来会说什么」更有用。
 * @param text - 正文。
 * @param kind - 消息来源类型。
 * @returns 裁剪后的正文。
 */
function clip(text, kind) {
  if (kind === 'compact-checkpoint') {
    return text.length > CHECKPOINT_CHARS ? `…${text.slice(-CHECKPOINT_CHARS)}` : text
  }
  return text.length > MAX_HISTORY_MESSAGE_CHARS ? text.slice(0, MAX_HISTORY_MESSAGE_CHARS) : text
}

export function collectHistory(messages, limit, route) {
  const wanted = Math.max(1, Math.floor(limit))
  const anchorIndex = newestUserIndex(messages)
  const picked = []
  let budget = MAX_HISTORY_TOTAL_CHARS
  let anchored = anchorIndex === -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (anchored && picked.length >= wanted) break
    const message = messages[index]
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    if (!isConversation(message)) continue
    const anchor = index === anchorIndex
    // 条数已经够了：只为补上最近的那条用户消息继续往前找，不再收助手消息。
    if (!anchor && picked.length >= wanted) continue
    const text = textOf(message)
    if (text === '') continue
    if (budget <= 0 && !anchor) break
    const clipped = clip(text, message.source.kind)
    const room = anchor ? Math.max(budget, ANCHOR_CHARS) : budget
    const body = clipped.slice(0, Math.min(clipped.length, room))
    if (body === '') break
    picked.push({
      id: `pch-${picked.length}`,
      role: message.role,
      source: message.role === 'user' ? { kind: 'user' } : { kind: 'model', provider: route.provider, model: route.model },
      content: [{ type: 'text', text: body }],
    })
    budget -= body.length
    if (message.role === 'user') anchored = true
  }
  return picked.reverse()
}

/**
 * 最近一条真实用户消息的下标，找不到时返回 -1。
 * @param messages - 派生消息。
 * @returns 下标或 -1。
 */
function newestUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || !isConversation(message)) continue
    if (textOf(message) === '') continue
    return index
  }
  return -1
}

/**
 * 从模型输出里解析候选列表。
 * @param raw - 模型返回的完整文本。
 * @param max - 候选数量上限。
 * @returns 去重、去空、按原顺序截断后的候选。
 */
export function parseCandidates(raw, max) {
  const text = stripFence(String(raw ?? '').trim())
  const fromJson = fromJsonPayload(text) ?? fromPartialJson(text)
  const list = fromJson ?? fromLines(text)
  const seen = new Set()
  const out = []
  for (const item of list) {
    const candidate = clean(item)
    if (candidate === '' || candidate.length > MAX_CANDIDATE_CHARS) continue
    const key = candidate.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
    if (out.length >= max) break
  }
  return out
}

function stripFence(text) {
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(text)
  return fenced === null ? text : fenced[1].trim()
}

function fromJsonPayload(text) {
  const start = [text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0)
  if (start.length === 0) return undefined
  const begin = Math.min(...start)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end <= begin) return undefined
  let parsed
  try {
    parsed = JSON.parse(text.slice(begin, end + 1))
  } catch {
    return undefined
  }
  if (Array.isArray(parsed)) return parsed.filter(item => typeof item === 'string')
  if (parsed !== null && typeof parsed === 'object') {
    const value = parsed.suggestions ?? parsed.candidates ?? parsed.prompts
    if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
  }
  return undefined
}

/**
 * 输出被 token 上限截断时，整段 JSON 解析不了，但前面几条完整字符串仍然可用。
 * @param text - 模型原文。
 * @returns 已完成的候选字符串，取不到时返回 undefined。
 */
function fromPartialJson(text) {
  const start = text.indexOf('"suggestions"')
  if (start < 0) return undefined
  const pattern = /"((?:[^"\\]|\\.)*)"/g
  pattern.lastIndex = start
  const out = []
  let match
  let skippedKey = false
  while ((match = pattern.exec(text)) !== null) {
    if (!skippedKey) {
      skippedKey = true
      continue
    }
    out.push(unescapeJson(match[1]))
  }
  return out.length === 0 ? undefined : out
}

/**
 * 还原 JSON 字符串转义；失败时原样返回。
 * @param value - 已去掉两侧引号的字符串本体。
 * @returns 还原后的文本。
 */
function unescapeJson(value) {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return value
  }
}

function fromLines(text) {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、:：])\s*/, '').trim())
    .filter(line => line !== '' && !line.startsWith('{') && !line.startsWith('['))
}

function clean(value) {
  return value
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
