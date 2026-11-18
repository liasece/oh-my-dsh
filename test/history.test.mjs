/**
 * `history.js` 的单测：谁能进入召回列表、顺序如何、条数怎么夹。
 * 运行：`node --test`
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { MAX_LIMIT, normalizeLimit, recentUserTexts } from '../lib/history/history.js'
import { historyOf } from '../lib/history/index.js'

const user = (text, kind = 'user') => ({
  role: 'user',
  source: { kind },
  content: [{ type: 'text', text }],
})
const assistant = text => ({
  role: 'assistant',
  source: { kind: 'model', provider: 'p', model: 'm' },
  content: [{ type: 'text', text }],
})

test('只取用户亲手发的消息，按时间顺序返回，最新的在最后', () => {
  const messages = [
    user('第一句'),
    assistant('收到'),
    user('第二句'),
  ]
  assert.deepEqual(recentUserTexts(messages, 10), ['第一句', '第二句'])
})

test('跳过框架注入的上下文、Agent 消息与助手消息', () => {
  const messages = [
    user('真的发过'),
    user('运行时上下文', 'runtime-context'),
    user('技能目录', 'skill-catalog'),
    user('压缩摘要', 'compact-checkpoint'),
    user('子会话的委托', 'agent-message'),
    assistant('回答'),
  ]
  assert.deepEqual(recentUserTexts(messages, 10), ['真的发过'])
})

test('跳过没有正文的消息（纯图片或纯附件）', () => {
  const messages = [
    user('有字'),
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a' } }] },
    user('   '),
  ]
  assert.deepEqual(recentUserTexts(messages, 10), ['有字'])
})

test('条数从最新一条往回数，结果仍按时间顺序', () => {
  const messages = [user('一'), user('二'), user('三'), user('四')]
  assert.deepEqual(recentUserTexts(messages, 2), ['三', '四'])
})

test('助手与框架注入的消息不占条数', () => {
  const messages = [
    user('最早'),
    assistant('答一'),
    user('第二'),
    user('运行时上下文', 'runtime-context'),
    user('子会话的委托', 'agent-message'),
    assistant('答二'),
  ]
  assert.deepEqual(recentUserTexts(messages, 2), ['最早', '第二'])
  assert.deepEqual(recentUserTexts(messages, 1), ['第二'])
})

test('条数夹到 [1, MAX_LIMIT]，坏值退回默认值', () => {
  assert.equal(normalizeLimit(undefined), 50)
  assert.equal(normalizeLimit(0), 50)
  assert.equal(normalizeLimit(-3), 50)
  assert.equal(normalizeLimit('x'), 50)
  assert.equal(normalizeLimit(1.9), 1)
  assert.equal(normalizeLimit(9999), MAX_LIMIT)
})

test('不是数组时返回空列表', () => {
  assert.deepEqual(recentUserTexts(undefined, 5), [])
  assert.deepEqual(recentUserTexts([], 5), [])
})

test('host 侧交给浏览器的只有用户亲手发的消息', () => {
  const ctx = {
    sessions: {
      get: () => ({
        deriveMessages: () => [
          user('你问的'),
          user('子会话的委托', 'agent-message'),
          assistant('答'),
          user('运行时上下文', 'runtime-context'),
          user('你又问的'),
        ],
      }),
    },
  }
  assert.deepEqual(historyOf(ctx, { limit: 100 }, 's1'), ['你问的', '你又问的'])
})

test('功能关闭、会话不在活动列表或派生消息失败时返回空列表', () => {
  const ctx = { sessions: { get: () => ({ deriveMessages: () => [user('x')] }) } }
  assert.deepEqual(historyOf(ctx, { enabled: false }, 's1'), [])
  assert.deepEqual(historyOf({ sessions: { get: () => undefined } }, {}, 'gone'), [])
  const broken = { logger: { warn: () => {} }, sessions: { get: () => ({ deriveMessages: () => { throw new Error('boom') } }) } }
  assert.deepEqual(historyOf(broken, {}, 's1'), [])
})
