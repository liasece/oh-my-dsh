import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

const TOOL = 'create_session'

// 普通会话可以收到访客、定时任务或别的 agent 发来的输入。只有本轮用户本人
// 发起的工作能创建用户拥有的新会话。上下文注入和历史替换不构成新的授权。
function requesterInTurn(requester, event) {
  if (event.type === 'turn/start' || event.type === 'turn/end') return 'none'
  if (event.type !== 'user/message' || event.surfaceOp !== 'append') return requester
  const source = event.data.source
  if (source?.kind !== 'user' || requester === 'guest') return requester
  return source.principal === undefined || source.principal?.kind === 'owner' ? 'owner' : 'guest'
}

function workspaceFor(registry, session, requested) {
  const workspaces = registry.list()
  if (requested === undefined) return workspaces.find(workspace => workspace.sessionIds.includes(session.id))
  const match = registry.get(requested) ?? workspaces.find(workspace => workspace.path === requested)
  if (match) return match
  const byTitle = workspaces.filter(workspace => workspace.title === requested)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) throw new Error('Several projects have that name. Use the exact project path or ID.')
  throw new Error('No registered DSH project matches that name, path or ID.')
}

async function hasWriteAccess(policy, destination) {
  if (policy?.mode !== 'workspace-write') return true
  const target = await realpath(destination)
  for (const root of [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]) {
    let canonicalRoot
    try {
      canonicalRoot = await realpath(root)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      throw error
    }
    const path = relative(canonicalRoot, target)
    if (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)) return true
  }
  return false
}

export async function registerCreateSession(ctx, section, api) {
  const requester = await ctx.sessionProjections.register({
    key: 'ohMyDshSessionRequester',
    stateVersion: 1,
    stateSchema: api.z.enum(['none', 'owner', 'guest']),
    init: () => 'none',
    apply: requesterInTurn,
  })
  const enabled = () => (typeof section?.enabled?.get === 'function' ? section.enabled.get() : section?.enabled) !== false
  const available = agent => {
    if (!enabled() || !agent || agent.session.header.origin === 'subagent') return false
    const parentId = agent.session.header.parentSession
    const owner = parentId === undefined ? undefined : ctx.agents.get(parentId)
    if (owner && ctx.agents.isOwnedBy(agent.id, owner)) return false
    const plan = ctx.get('planMode')
    return !plan?.loggedActive(agent.session) && !plan?.selectedActive(agent.session)
  }
  const check = ({ agent, signal }) => {
    signal.throwIfAborted()
    if (!available(agent) || ctx.agents.get(agent.id) !== agent) throw new Error('Session creation is unavailable for this agent.')
    if (requester.stateOf(agent.session) !== 'owner') throw new Error('Creating a conversation requires a request from its user in the current turn.')
  }
  // callId 只在本步比较。另一模型步可以复用同一名字，PTC 子调用各有自己的 ID。
  const calls = new WeakMap()

  async function create(args, exec) {
    const { agent, signal } = exec
    const prompt = args.prompt
    if (!prompt.trim()) throw new Error('The first prompt must contain text.')
    const titles = ctx.sessionTitle.config
    const title = args.title === undefined
      ? api.fallbackSessionTitle(prompt, titles.fallbackMaxWords, titles.fallbackMaxBytes)
      : api.normalizeSessionTitle(args.title, titles.maxTitleBytes)
    if (!title) throw new Error('The conversation title must contain visible text.')

    const session = agent.session
    const workspace = workspaceFor(ctx.workspaceRegistry, session, args.workspace)
    const currentDirectory = ctx.workingDirectory.get(session)
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const approvalService = ctx.get('approval')
    const permissionPresets = ctx.get('permissionPresets')
    const sandbox = sandboxPolicy?.resolve({ session })
    const approval = approvalService?.effectivePolicy(session)
    const permissionPreset = permissionPresets?.current(session)
    function checkScope() {
      check(exec)
      // 审批弹窗打开时用户仍可切换权限。不要把旧的沙箱与新的审批预设拼在一起。
      if (sandboxPolicy?.resolve({ session }).mode !== sandbox?.mode ||
          approvalService?.effectivePolicy(session) !== approval ||
          permissionPresets?.current(session) !== permissionPreset) {
        throw new Error('Permissions changed while creating the conversation. Try again with the current permissions.')
      }
    }
    // header.cwd 决定持久项目归属和沙箱根。会话内 cd 到的目录另由 workingDirectory 管理。
    const cwd = workspace?.path ?? session.header.cwd ?? sandbox?.workspaceRoot ?? currentDirectory
    const sameProject = workspace === undefined || workspace.sessionIds.includes(session.id)
    if (!sameProject && !await hasWriteAccess(sandbox, cwd)) {
      const answer = await approvalService?.request({
        agent, signal, toolName: TOOL, callId: exec.callId,
        reason: `Create “${title}” with workspace-write access to ${cwd}. First prompt: ${prompt}`,
      })
      if (answer !== 'allowed-once') throw new Error('Creating a conversation with write access to that project was not approved.')
    }
    checkScope()
    const presets = ctx.get('agentPresets')
    const agentPreset = presets?.composedPreset(agent.ctx)
    const model = agent.model.current()
    if (!model) throw new Error('The calling conversation has no model selected.')
    const sessionId = `session-${randomUUID()}`
    const firstMessage = api.createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: agent.id },
    })

    // 与手动新建共用普通 Agent 工厂。权限、工具预设和模型在发布 agent 前就位，
    // 没有父 agent 的运行时所有权，结束发起会话也不会终止新会话。
    const { agent: created } = await ctx.agents.create({
      sessionId,
      signal,
      agentOptions: { ...model, maxTokens: agent.options.maxTokens },
      meta: { cwd, ...(agentPreset === undefined ? {} : { agentPreset }) },
      setup(childCtx, child) {
        checkScope()
        api.installModelSelection(childCtx)
        presets?.composeFrom(childCtx, agent.ctx)
        if (sandbox) api.setSandboxMode(child.session, sandbox.mode)
        if (approval) api.setApprovalPolicy(child.session, approval)
        if (permissionPreset && permissionPreset !== 'custom') child.session.append('permission/preset', { preset: permissionPreset })
        child.model.select(model)
        ctx.sessionTitle.rename(child.session, title)
      },
    }).catch(error => {
      // 工厂会先创建持久化记录，再公布 agent。即使初始化失败也给出可定位的 ID。
      throw new Error(`DSH could not finish creating ${sessionId}: ${error?.message ?? error}`, { cause: error })
    })
    const result = { sessionId, title, ...(workspace ? { workspaceId: workspace.id } : {}) }
    try {
      if (workspace) await workspace.attachSession(sessionId)
      if (sameProject && currentDirectory !== cwd) await ctx.workingDirectory.set(created, currentDirectory, signal)
      checkScope()
      created.followup(firstMessage)
      return { ...result, started: true }
    } catch (error) {
      // 会话已持久化。返回身份与实际投递状态，让用户能在同一会话继续。
      return { ...result, started: false, error: String(error?.message ?? error) }
    }
  }

  ctx.tools.register(api.defineTool({
    name: TOOL,
    description: 'Create a separate, user-visible DSH conversation and start its first prompt. Use only when the user explicitly asks to open a new conversation. Give the new agent a self-contained prompt. Return the title and session ID to the user. For temporary delegated work, use the subagent tools.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'First task for the new conversation. It starts with an empty history.' },
      title: { type: 'string', description: 'Optional sidebar title. Defaults to the opening words of the prompt.' },
      workspace: { type: 'string', description: 'Use only if the user names another existing DSH project. Accepts its exact name, path or ID. Defaults to the current project.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          workspaceId: { type: 'string' },
          started: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    async execute(args, exec) {
      check(exec)
      const step = ctx.agents.turnBoundaryOf(exec.agent.session).lastStepStartSeq
      let batch = calls.get(exec.agent)
      if (!batch || batch.step !== step) {
        batch = { step, results: new Map() }
        calls.set(exec.agent, batch)
      }
      if (!batch.results.has(exec.callId)) batch.results.set(exec.callId, create(args, exec))
      return await batch.results.get(exec.callId)
    },
  }), { when: ({ agent }) => available(agent) })
}
