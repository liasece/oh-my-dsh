/**
 * 合并后的 Typert 服务：一个 `ohMyDsh` 服务挂两个方法。
 *
 * 两个功能各自只关心自己的配置段与业务逻辑，挂载、取消与生命周期在这里统一处理：
 *   - `candidates` 沿用「每个会话按日志长度去重」的缓存；
 *   - `history` 每次现读会话日志，召回内容永远与磁盘上的一致。
 */
import { importShipped } from './shipped.js'
import { createManifest } from './typert.js'
import { PACKAGE } from './remote.js'
import { createCandidateCache, enabled as candidatesEnabled } from './candidates/index.js'
import { historyOf } from './history/index.js'

const [protocol, zod] = await Promise.all([
  importShipped('@deepseek-ai/dsh-typert-protocol'),
  importShipped('zod'),
])
const z = zod.z ?? zod.default ?? zod

/** 没有候选时的统一形状。 */
const none = reason => ({ suggestions: [], reason })

/** 等一个 Promise，但调用方中止时立即放弃等待；共享的生成仍在继续。 */
function untilAborted(promise, signal) {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * 注册 `ohMyDsh` 服务并挂上清单。
 * @param ctx 宿主上下文（需要 `typert`、`sessions`）。
 * @param options 两个功能各自的配置段。
 * @returns 清理函数与缓存句柄。
 */
export function registerService(ctx, options) {
  const { Remote, TypertRemoteService, createTypertRemoteInfo } = protocol
  const { candidates, history } = options
  const cache = createCandidateCache(ctx, candidates)
  /** `@Remote` 标记产生的实例初始化器。 */
  const remoteInitializers = []

  class OhMyDshController extends TypertRemoteService {
    constructor(serviceCtx) {
      super(serviceCtx, 'ohMyDsh')
      for (const initializer of remoteInitializers) initializer.call(this)
      serviceCtx.effect(() => () => cache.abortAll(), 'oh-my-dsh: 取消未完成的候选生成')
    }

    /**
     * 为刚结束一个回合的会话生成下一条提示词候选。
     * @param sessionId - 会话身份。
     * @param signal - 调用方取消；只停止这次等待，不停止共享的生成。
     * @returns 候选列表，或空列表与抑制原因。
     */
    async candidates({ sessionId }, signal) {
      if (!candidatesEnabled(candidates)) {
        cache.abortAll()
        return none('disabled')
      }
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) return none('session-inactive')
      return await untilAborted(cache.get(session, signal), signal)
    }

    /**
     * 读取一个会话的用户消息文本。
     * @param request - 会话与条数上限。
     * @returns 最早的一条在前；功能关闭或会话不在活动列表里时是空数组。
     */
    async history(request) {
      return { messages: historyOf(ctx, history, request.sessionId) }
    }
  }

  Remote(OhMyDshController.prototype.candidates, {
    kind: 'method',
    name: 'candidates',
    static: false,
    private: false,
    addInitializer: initializer => remoteInitializers.push(initializer),
  })
  Remote(OhMyDshController.prototype.history, {
    kind: 'method',
    name: 'history',
    static: false,
    private: false,
    addInitializer: initializer => remoteInitializers.push(initializer),
  })

  ctx.typert.register(createManifest(createTypertRemoteInfo, z))
  ctx.plugin(OhMyDshController)

  return { cache }
}
