import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import { isSentMessage } from '../lib/history/history.js'
import { Config } from '../lib/session-creation/index.js'
import { registerCreateSession } from '../lib/session-creation/tool.js'

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oh-my-dsh-session-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const env = { enabled: true, plan: false, mode: 'workspace-write', approval: 'denied', approvals: [], live: new Map(), creations: [] }
  const workspaces = []
  for (const name of ['design', 'docs']) {
    const path = join(dir, name)
    await mkdir(path)
    workspaces.push({
      id: 'ws-' + name, title: name, path, sessionIds: [],
      async attachSession(id) {
        if (!this.sessionIds.includes(id)) this.sessionIds.unshift(id)
      },
    })
  }
  env.workspaces = workspaces
  const [home] = workspaces
  const route = { provider: 'example', model: 'current', reasoningEffort: 'medium' }
  function makeAgent(id, meta, model) {
    const session = {
      id, header: { id, ...meta }, events: [], cwd: meta.cwd,
      append(type, data, extras) { this.events.push({ type, data, ...extras }) },
    }
    return {
      id, session, options: { maxTokens: 400 }, ctx: {}, inbox: [],
      model: {
        current: () => model,
        select(selection) { model = selection },
      },
      followup(message) { this.inbox.push(message) },
    }
  }
  const parent = makeAgent('source', { cwd: home.path }, route)
  parent.session.cwd = join(home.path, 'src')
  await mkdir(parent.session.cwd)
  parent.ctx.preset = 'writer'
  env.live.set(parent.id, parent)
  home.sessionIds.push(parent.id)
  env.parent = parent
  env.step = 5
  const services = {
    agentPresets: {
      composedPreset: ctx => ctx.preset,
      composeFrom: (ctx, owner) => { ctx.preset = owner.preset },
    },
    sandboxPolicy: { resolve: () => ({ mode: env.mode, workspaceRoot: home.path, additionalWritableRoots: env.extraRoots }) },
    approval: {
      effectivePolicy: () => 'ask',
      request: async request => {
        env.approvals.push(request)
        env.onApproval?.()
        return env.approval
      },
    },
    permissionPresets: { current: () => 'auto' },
    planMode: { loggedActive: () => env.plan, selectedActive: () => env.plan },
  }
  const ctx = {
    get: key => services[key],
    agents: {
      get: id => env.live.get(id),
      isOwnedBy: (id, owner) => env.live.get(id)?.owner === owner,
      turnBoundaryOf: () => ({ lastStepStartSeq: env.step }),
      async create(options) {
        env.creations.push(options)
        const child = makeAgent(options.sessionId, options.meta)
        await options.setup(child.ctx, child)
        env.live.set(child.id, child)
        return { agent: child }
      },
    },
    sessionProjections: {
      async register(unit) {
        return { stateOf: session => session.events.reduce(unit.apply, unit.init(session.header)) }
      },
    },
    tools: { register(tool, { when }) { env.tool = tool; env.visible = agent => when({ agent }) } },
    workspaceRegistry: { list: () => workspaces, get: id => workspaces.find(ws => ws.id === id) },
    workingDirectory: {
      get: session => session.cwd,
      set: async (agent, cwd) => { agent.session.cwd = cwd },
    },
    sessionTitle: {
      config: { fallbackMaxWords: 6, fallbackMaxBytes: 80, maxTitleBytes: 180 },
      rename: (session, title) => session.append('session/title', { title }),
    },
  }
  await registerCreateSession(ctx, { enabled: { get: () => env.enabled } }, {
    z, defineTool: spec => spec,
    installModelSelection: () => {},
    createUserMessage: value => ({ role: 'user', ...value }),
    normalizeSessionTitle: title => title.trim(),
    fallbackSessionTitle: prompt => prompt.trim().split('\n')[0],
    setSandboxMode: (session, mode) => session.append('sandbox/mode', { mode }),
    setApprovalPolicy: (session, policy) => session.append('approval/policy', { policy }),
  })
  env.turn = (source = { kind: 'user' }, agent = parent) => {
    agent.session.append('turn/start', {})
    agent.session.append('user/message', { source }, { surfaceOp: 'append' })
  }
  env.turn()
  env.call = (args = { prompt: 'Review the guide' }, overrides = {}) =>
    env.tool.execute(args, { agent: parent, callId: 'call-1', signal: new AbortController().signal, ...overrides })
  return env
}

test('普通会话收到独立任务，归入相同项目并继承工作目录、模型、预设和权限', async t => {
  const h = await harness(t)
  assert.equal(Config({}).enabled.get(), true)
  assert.equal(h.tool.name, 'create_session')
  const args = { title: '文档审阅', prompt: '检查指南中的命令。\n把需要修订的段落列出来。' }
  const [result, replay] = await Promise.all([h.call(args), h.call(args)])
  assert.deepEqual(result, replay)
  assert.equal(result.started, true)
  assert.equal(result.title, args.title)
  assert.equal(h.creations.length, 1)
  const [creation] = h.creations
  assert.equal(creation.parentAgent, undefined)
  assert.equal(creation.seed, undefined)
  assert.deepEqual(creation.meta, { cwd: h.workspaces[0].path, agentPreset: 'writer' })
  assert.deepEqual(h.workspaces[0].sessionIds, [result.sessionId, 'source'])
  const child = h.live.get(result.sessionId)
  assert.deepEqual(child.model.current(), h.parent.model.current())
  assert.equal(child.ctx.preset, 'writer')
  assert.equal(child.session.cwd, h.parent.session.cwd)
  assert.deepEqual(child.session.events.map(event => [event.type, event.data]), [
    ['sandbox/mode', { mode: 'workspace-write' }], ['approval/policy', { policy: 'ask' }],
    ['permission/preset', { preset: 'auto' }], ['session/title', { title: args.title }],
  ])
  assert.deepEqual(child.inbox, [{
    role: 'user', content: [{ type: 'text', text: args.prompt }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: h.parent.id },
  }])
  assert.equal(isSentMessage(child.inbox[0]), false)
  assert.equal(h.approvals.length, 0)
  h.step++
  assert.notEqual((await h.call(args)).sessionId, result.sessionId)
})

test('开关、调用身份和本轮消息来源在实际执行时生效', async t => {
  const h = await harness(t)
  assert.equal(h.visible(h.parent), true)
  h.enabled = false
  assert.equal(h.visible(h.parent), false)
  await assert.rejects(h.call(), /unavailable/)
  h.enabled = true
  await assert.rejects(h.call(undefined, { agent: undefined }), /unavailable/)
  h.parent.session.header.origin = 'subagent'
  assert.equal(h.visible(h.parent), false)
  await assert.rejects(h.call(), /unavailable/)
  delete h.parent.session.header.origin
  const owner = { id: 'parent-of-legacy-session' }
  h.live.set(owner.id, owner)
  h.parent.session.header.parentSession = owner.id
  h.parent.owner = owner
  assert.equal(h.visible(h.parent), false)
  delete h.parent.owner
  assert.equal(h.visible(h.parent), true)
  h.plan = true
  await assert.rejects(h.call(), /unavailable/)
  h.plan = false
  for (const source of [{ kind: 'user', principal: { kind: 'guest' } }, { kind: 'agent-message' }, { kind: 'schedule' }]) {
    h.turn(source)
    await assert.rejects(h.call(), /current turn/)
  }
  assert.equal(h.creations.length, 0)
  h.turn()
  const child = h.live.get((await h.call()).sessionId)
  h.live.delete(h.parent.id)
  h.turn({ kind: 'user' }, child)
  assert.equal((await h.call(undefined, { agent: child })).started, true)
})

test('其他已有项目按名字、路径或 ID 匹配，扩大可写范围需当前宿主授权', async t => {
  const h = await harness(t)
  const [home, other] = h.workspaces
  const args = { workspace: other.title, prompt: '编写索引' }
  await assert.rejects(h.call(args), /not approved/)
  assert.equal(h.creations.length, 0)
  assert.equal(h.approvals[0].agent, h.parent)
  h.approval = 'allowed-once'
  for (const workspace of [other.id, other.path]) {
    h.step++
    const result = await h.call({ ...args, workspace })
    assert.equal(result.workspaceId, other.id)
    assert.equal(h.live.get(result.sessionId).session.cwd, other.path)
    assert.ok(other.sessionIds.includes(result.sessionId))
  }
  assert.deepEqual(home.sessionIds, ['source'])
  h.step++
  await assert.rejects(h.call({ ...args, workspace: '/unknown/path' }), /No registered/)
  other.title = home.title
  h.step++
  await assert.rejects(h.call({ ...args, workspace: home.title }), /Several projects/)
})

test('符号链接指向沙箱外的项目仍走原来的审批', async t => {
  const h = await harness(t)
  const [home, other] = h.workspaces
  const link = join(home.path, 'docs')
  await symlink(other.path, link)
  other.path = link
  await assert.rejects(h.call({ prompt: '编写索引', workspace: link }), /not approved/)
  assert.equal(h.creations.length, 0)
})

test('已获写权限的目标项目直接使用，等待批准时收紧权限不会留下越权会话', async t => {
  const h = await harness(t)
  const [home, other] = h.workspaces
  const args = { prompt: '补充文档', workspace: other.title }
  h.extraRoots = [join(home.path, 'removed'), other.path]
  assert.equal((await h.call(args)).started, true)
  assert.equal(h.approvals.length, 0)

  h.step++
  h.extraRoots = []
  h.onApproval = () => { h.mode = 'read-only' }
  h.approval = 'allowed-once'
  await assert.rejects(h.call(args), /Permissions changed/)
  assert.equal(h.creations.length, 1)
})

test('无项目归属时沿用原根目录，空消息与取消调用不创建会话', async t => {
  const h = await harness(t)
  h.workspaces[0].sessionIds = []
  await assert.rejects(h.call({ prompt: ' \n ' }), /first prompt/)
  await assert.rejects(h.call(undefined, { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/)
  assert.equal(h.creations.length, 0)
  h.step++
  const result = await h.call()
  assert.equal(result.workspaceId, undefined)
  assert.equal(h.live.get(result.sessionId).session.header.cwd, h.parent.session.header.cwd)
})

test('创建后挂入项目失败会返回会话 ID，重放不会另建会话或误投任务', async t => {
  const h = await harness(t)
  h.workspaces[0].attachSession = async () => { throw new Error('project unavailable') }
  const result = await h.call()
  assert.equal(result.started, false)
  assert.match(result.error, /project unavailable/)
  assert.equal(h.live.get(result.sessionId).inbox.length, 0)
  assert.deepEqual(await h.call(), result)
  assert.equal(h.creations.length, 1)
})
