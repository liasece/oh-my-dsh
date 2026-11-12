/**
 * `ohMyDsh/*` 的宿主侧 Typert 清单，等价于生成产物。
 *
 * 在激活时构造，因为 Typert 协议与 Zod 只能通过 Loader 到达。
 */
import { PACKAGE, SERVICE, remoteSpec } from './remote.js'

const CANDIDATES_DOC = '为刚结束一个回合的会话生成最多 N 条下一条提示词候选。'
const HISTORY_DOC = '读取一个会话里用户发送过的消息文本，供输入框按 ↑ 召回。'

/**
 * @param createTypertRemoteInfo - 来自 `@deepseek-ai/dsh-typert-protocol`。
 * @param z - Zod 命名空间。
 * @returns 可交给 `ctx.typert.register()` 的清单。
 */
export function createManifest(createTypertRemoteInfo, z) {
  const $remote = createTypertRemoteInfo(remoteSpec(z), z)
  return {
    package: PACKAGE,
    face: 'host',
    schemas: [],
    get invocations() { return $remote.descriptors },
    get descriptors() { return $remote.descriptors },
    model: {
      services: [{
        description: '把峰谷动态、提示词候选、输入历史合到一个插件里的小工具集。',
        summary: 'OhMyDSH：峰谷动态、提示词候选、输入历史。',
        tags: [],
        jsDoc: '/** OhMyDSH：峰谷动态、提示词候选、输入历史。 */',
        key: SERVICE,
        exportName: 'default',
        members: [
          {
            kind: 'method',
            name: 'candidates',
            signature: '@Remote async candidates(request: CandidatesRequest, signal: AbortSignal): Promise<CandidatesResult>',
            summary: CANDIDATES_DOC,
            jsDoc: `/** ${CANDIDATES_DOC} */`,
          },
          {
            kind: 'method',
            name: 'history',
            signature: '@Remote async history(request: HistoryRequest): Promise<HistoryResult>',
            summary: HISTORY_DOC,
            jsDoc: `/** ${HISTORY_DOC} */`,
          },
        ],
        types: [
          { name: 'CandidatesRequest', declaration: 'export interface CandidatesRequest {\n    readonly sessionId: string;\n}' },
          { name: 'CandidatesResult', declaration: 'export interface CandidatesResult {\n    readonly suggestions: readonly string[];\n    readonly reason: string;\n}' },
          { name: 'HistoryRequest', declaration: 'export interface HistoryRequest {\n    readonly sessionId: string;\n    readonly limit?: number;\n}' },
          { name: 'HistoryResult', declaration: 'export interface HistoryResult {\n    readonly messages: readonly string[];\n}' },
        ],
      }],
      events: [],
      objects: [],
    },
  }
}
