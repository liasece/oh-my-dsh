/**
 * `ohMyDsh/*` 的 Typert Remote 定义：宿主清单与浏览器模块各持一份同样的 spec
 * （浏览器侧不能引用这个文件）。
 *
 * 合并前是两个插件各有一个服务（`dshPromptCandidates`、`dshPromptHistory`），
 * 现在是同一个服务 `ohMyDsh` 下的两个方法：候选与历史共用一次挂载。
 */

/** 插件包名，也是 profile 里的条目 id 与设置命名空间。 */
export const PACKAGE = 'oh-my-dsh'

/** 浏览器侧注入的服务名：`ctx.remote.ohMyDsh.*`。 */
export const SERVICE = 'ohMyDsh'

const CANDIDATES_REQUEST_JSON = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: '刚刚结束一个回合的会话。' },
  },
  required: ['sessionId'],
}
const CANDIDATES_RESULT_JSON = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: { type: 'string' },
      description: '按推荐顺序排列的下一条提示词候选；没有可推荐的时为空中数组。',
    },
    reason: { type: 'string', description: '为什么给出这些候选，或为什么没有候选。' },
  },
  required: ['suggestions', 'reason'],
}
const HISTORY_REQUEST_JSON = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: '要读取历史的会话。' },
    limit: { type: 'number', description: '最多往回翻多少条，取值 1–200。' },
  },
  required: ['sessionId'],
}
const HISTORY_RESULT_JSON = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: { type: 'string' },
      description: '用户消息文本，最早的一条在前；没有历史时是空数组。',
    },
  },
  required: ['messages'],
}

/**
 * 用调用方的 Zod 运行时构造 Remote spec。
 * @param z - Zod 命名空间。
 * @returns 可交给 `createTypertRemoteInfo` 的 spec。
 */
export function remoteSpec(z) {
  let candidatesRequest, strictCandidatesRequest, candidatesResult
  let historyRequest, strictHistoryRequest, historyResult
  return {
    package: PACKAGE,
    methods: {
      'ohMyDsh/candidates': {
        service: SERVICE,
        description: '为刚结束一个回合的会话生成最多 N 条下一条提示词候选。',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          description: '会话身份。',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#CandidatesRequest`,
            create: () => (candidatesRequest ??= z.object({ sessionId: z.string() })),
            jsonSchema: { ...CANDIDATES_REQUEST_JSON, additionalProperties: true },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#CandidatesRequest`,
            create: () => (strictCandidatesRequest ??= z.strictObject({ sessionId: z.string() })),
            jsonSchema: { ...CANDIDATES_REQUEST_JSON, additionalProperties: false },
          },
        }],
        cancellation: { parameter: 'signal' },
        result: {
          mode: 'strict',
          typeSymbol: `${PACKAGE}#ohMyDsh/candidates:result`,
          create: () => (candidatesResult ??= z.object({ suggestions: z.array(z.string()), reason: z.string() })),
          description: '候选列表，空数组表示本轮不展示。',
          jsonSchema: CANDIDATES_RESULT_JSON,
        },
      },
      'ohMyDsh/history': {
        service: SERVICE,
        description: '读取一个会话里用户发送过的消息文本，供输入框按 ↑ 召回。',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          description: '会话与条数上限。',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#HistoryRequest`,
            create: () => (historyRequest ??= z.object({ sessionId: z.string(), limit: z.number().optional() })),
            jsonSchema: { ...HISTORY_REQUEST_JSON, additionalProperties: true },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#HistoryRequest`,
            create: () => (strictHistoryRequest ??= z.strictObject({ sessionId: z.string(), limit: z.number().optional() })),
            jsonSchema: { ...HISTORY_REQUEST_JSON, additionalProperties: false },
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: `${PACKAGE}#ohMyDsh/history:result`,
          create: () => (historyResult ??= z.object({ messages: z.array(z.string()) })),
          description: '用户消息文本，最早的一条在前；没有历史时是空数组。',
          jsonSchema: HISTORY_RESULT_JSON,
        },
      },
    },
  }
}
