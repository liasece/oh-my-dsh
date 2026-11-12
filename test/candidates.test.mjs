/**
 * 提示词候选的宿主逻辑：生成、抑制原因、按会话去重。
 *
 * 用例不碰网络：`ctx.llm.prepareCall` 与 `call.stream` 都是替身，只喂回固定的
 * 分片。这样能覆盖「什么时候不生成」和「生成出来的东西怎么裁剪」这两类容易
 * 回归的判断，而不依赖模型。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { generateCandidates, enabled, createCandidateCache } = await import('../lib/candidates/index.js')

/** 一条助手消息（纯文本）。 */
const assistant = (text = '好的，已经改完。') => ({
  role: 'assistant',
  source: { kind: 'assistant' },
  content: [{ type: 'text', text }],
})

/** 一条用户消息（纯文本）。 */
const user = (text = '帮我把这个函数拆开') => ({
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

/** 造一个会话替身：`messages` 是它导出的日志，`header` 决定请求路线。 */
function fakeSession({ messages = [user(), assistant()], header = { config: { provider: 'p-1', model: 'm-1' } }, id = 's1', seq = 1 } = {}) {
  return {
    id,
    seq,
    deriveMessages: () => messages,
    requestHeader: () => header,
  }
}

/**
 * 造一个宿主替身：`llm` 按给定分片回放。
 * @param chunks - 依次产出的流分片。
 */
function fakeContext(chunks, { onCall } = {}) {
  const calls = []
  return {
    calls,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm: {
      async prepareCall(proposal) {
        calls.push(proposal)
        if (onCall !== undefined) onCall(proposal)
        return {
          config: { ...proposal },
          async *stream(options) {
            calls[calls.length - 1] = { ...calls[calls.length - 1], options }
            for (const chunk of chunks) yield chunk
          },
        }
      },
    },
  }
}

/** 正常回一段 JSON 数组。 */
const textChunks = (text) => [
  { type: 'text-delta', text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 一份基本配置（值都是普通值，等同宿主解析后的结果）。 */
const section = (patch = {}) => ({
  enabled: true,
  maxSuggestions: 2,
  historyMessages: 12,
  maxOutputTokens: 1600,
  timeoutMs: 25000,
  provider: '',
  model: '',
  debug: false,
  ...patch,
})

test('正常生成：解析 JSON、去重、截断到 maxSuggestions', async () => {
  const text = '简介：```json\n{"suggestions":[" 第一  条 ","第二条","第二条","第三条"]}\n```'
  const ctx = fakeContext(textChunks(text))
  const result = await generateCandidates(ctx, section({ maxSuggestions: 2 }), fakeSession(), new AbortController().signal)
  assert.equal(result.reason, 'ok')
  assert.deepEqual(result.suggestions, ['第一 条', '第二条'], '去重后按顺序截断')
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].maxTokens, 1600, '输出上限换成候选用的小额度')
  assert.equal(ctx.calls[0].provider, 'p-1', '沿用会话自己的路线')
})

test('provider / model 都设置时改用覆盖路线', async () => {
  const ctx = fakeContext(textChunks('["a","b"]'))
  await generateCandidates(ctx, section({ provider: 'p-2', model: 'm-2' }), fakeSession(), new AbortController().signal)
  assert.equal(ctx.calls[0].provider, 'p-2')
  assert.equal(ctx.calls[0].model, 'm-2')
})

test('回合没收尾（末条不是助手）时不请求', async () => {
  const ctx = fakeContext(textChunks('["a"]'))
  const result = await generateCandidates(ctx, section(), fakeSession({ messages: [assistant(), user()] }), new AbortController().signal)
  assert.equal(result.reason, 'not-at-turn-end')
  assert.equal(ctx.calls.length, 0)
})

test('末条是工具调用时不请求', async () => {
  const ctx = fakeContext(textChunks('["a"]'))
  const messages = [user(), { ...assistant(), content: [{ type: 'tool-call', name: 'read' }] }]
  const result = await generateCandidates(ctx, section(), fakeSession({ messages }), new AbortController().signal)
  assert.equal(result.reason, 'not-at-turn-end')
  assert.equal(ctx.calls.length, 0)
})

test('助手最后一轮没有说话内容时不请求', async () => {
  const ctx = fakeContext(textChunks('["a"]'))
  const result = await generateCandidates(ctx, section(), fakeSession({ messages: [user(), assistant('')] }), new AbortController().signal)
  assert.equal(result.reason, 'no-assistant-text')
  assert.equal(ctx.calls.length, 0)
})

test('没有请求头时不请求（无从得知路线）', async () => {
  const ctx = fakeContext(textChunks('["a"]'))
  const noHeader = { id: 's1', seq: 1, deriveMessages: () => [user(), assistant()], requestHeader: () => undefined }
  const result = await generateCandidates(ctx, section(), noHeader, new AbortController().signal)
  assert.equal(result.reason, 'no-request-header')
  assert.equal(ctx.calls.length, 0)
})

test('历史里没有用户消息时不请求', async () => {
  const ctx = fakeContext(textChunks('["a"]'))
  const result = await generateCandidates(ctx, section(), fakeSession({ messages: [assistant()] }), new AbortController().signal)
  assert.equal(result.reason, 'no-user-message')
  assert.equal(ctx.calls.length, 0)
})

test('模型要求工具调用 → 放弃这一轮', async () => {
  const ctx = fakeContext([{ type: 'tool-call-delta', name: 'read' }])
  const result = await generateCandidates(ctx, section(), fakeSession(), new AbortController().signal)
  assert.equal(result.reason, 'tool-call')
})

test('非正常收尾（比如长度截断）带上原因', async () => {
  const ctx = fakeContext([{ type: 'text-delta', text: '半截' }, { type: 'finish', reason: { kind: 'length' } }])
  const result = await generateCandidates(ctx, section(), fakeSession(), new AbortController().signal)
  assert.equal(result.reason, 'finish-length')
})

test('解析不出候选时不报错，只给 no-candidates', async () => {
  const ctx = fakeContext(textChunks('   '))
  const result = await generateCandidates(ctx, section(), fakeSession(), new AbortController().signal)
  assert.equal(result.reason, 'no-candidates')
  assert.deepEqual(result.suggestions, [])
})

test('设置页写入越界的条数也不让这一轮失效（夹回范围内）', async () => {
  const ctx = fakeContext(textChunks('["a","b","c"]'))
  const result = await generateCandidates(ctx, section({ maxSuggestions: 99 }), fakeSession(), new AbortController().signal)
  assert.equal(result.reason, 'ok')
  assert.equal(result.suggestions.length, 2, '越界值退回默认的 2，而不是让这一轮失效')
})

test('开关缺省视为启用，显式为 false 才算关', () => {
  assert.equal(enabled({}), true)
  assert.equal(enabled(undefined), true)
  assert.equal(enabled({ enabled: { get: () => false } }), false)
  assert.equal(enabled({ enabled: { get: () => true } }), true)
})

test('同一会话同一轮只生成一次，进入下一轮时取消旧的', async () => {
  let resolveFirst
  const first = new Promise((resolve) => { resolveFirst = resolve })
  let calls = 0
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    llm: {
      async prepareCall(proposal) {
        calls += 1
        return {
          config: { ...proposal },
          async *stream() {
            await first
            yield { type: 'text-delta', text: '["a"]' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
  const cache = createCandidateCache(ctx, section())
  const session = fakeSession({ seq: 1 })
  const one = cache.get(session, new AbortController().signal)
  const two = cache.get(session, new AbortController().signal)
  resolveFirst()
  assert.deepEqual((await one).suggestions, ['a'])
  assert.deepEqual((await two).suggestions, ['a'], '同一轮重复请求拿到同一份结果')
  assert.equal(calls, 1, '只发了一次请求')

  // 进入下一轮：旧的被取消，新的一次独立生成。
  cache.get(fakeSession({ seq: 2 }), new AbortController().signal)
  assert.equal(calls, 2)
})
