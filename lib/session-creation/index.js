import { importShipped } from '../shipped.js'
import { registerCreateSession } from './tool.js'

const { default: Schema } = await importShipped('@deepseek-ai/schemastery')

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile()
    .description('允许 agent 应用户要求创建一个可在侧栏继续对话的独立会话。'),
})

export function apply(ctx, section) {
  // 精简 profile 可以缺少会话创建所用的服务，其他功能仍可独立挂载。
  ctx.inject(['tools', 'agents', 'workspaceRegistry', 'workingDirectory', 'sessionTitle', 'sessionProjections'], async host => {
    const [tools, llm, agents, titles, sandbox, approval, { z }] = await Promise.all([
      importShipped('@deepseek-ai/dsh-tools'),
      importShipped('@deepseek-ai/dsh-llm'),
      importShipped('@deepseek-ai/dsh-agent'),
      importShipped('@deepseek-ai/dsh-session-title'),
      importShipped('@deepseek-ai/dsh-sandbox-policy'),
      importShipped('@deepseek-ai/dsh-user-approval'),
      importShipped('zod'),
    ])
    await registerCreateSession(host, section, {
      defineTool: tools.defineTool,
      createUserMessage: llm.createUserMessage,
      installModelSelection: agents.installModelSelection,
      normalizeSessionTitle: titles.normalizeSessionTitle,
      fallbackSessionTitle: titles.fallbackSessionTitle,
      setSandboxMode: sandbox.setSandboxMode,
      setApprovalPolicy: approval.setApprovalPolicy,
      z,
    })
  })
}
