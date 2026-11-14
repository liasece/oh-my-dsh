/**
 * OhMyDSH —— 把三个插件合成一个：峰谷动态、提示词候选、输入历史。
 *
 * 合并的原则是「设置全部保留」：
 *   - 每个功能在配置里占一段（`peakValley`／`candidates`／`history`），字段名与语义
 *     与原插件一致，所以原来写在 profile 里的值可以原样搬过来；
 *   - 每段都有一个 `enabled` 开关，关掉后该功能的所有入口都空转，但不卸载：
 *     设置页一打开就立刻生效，不需要重启 DSH；
 *   - 三个功能的设置页仍然各占一页（设置里的「峰谷动态」「输入框候选」「输入历史」），
 *     页面里的开关就是那一段的 `enabled`。
 *
 * 三段的字段都是 volatile 的，宿主设置只投影这些字段：浏览器侧写入后，运行中的
 * 插件立即读到新值。
 */
import { importShipped } from './lib/shipped.js'
import * as peakValley from './lib/peak-valley/index.js'
import * as candidates from './lib/candidates/index.js'
import * as history from './lib/history/index.js'
import { registerService } from './lib/service.js'

const [{ default: Schema }] = await Promise.all([importShipped('@deepseek-ai/schemastery')])

export const name = 'oh-my-dsh'

/** 三个功能都要读会话；候选还要调模型。 */
export const inject = ['llm', 'sessions', 'typert']

/** 插件配置：三段，各自独立。 */
export const Config = Schema.object({
  peakValley: peakValley.Config,
  candidates: candidates.Config,
  history: history.Config,
})

/**
 * @param ctx 宿主上下文。
 * @param config 已解析的配置；三段都是活引用（volatile），读值时再取。
 */
export function apply(ctx, config) {
  const sections = {
    peakValley: config?.peakValley ?? {},
    candidates: config?.candidates ?? {},
    history: config?.history ?? {},
  }

  peakValley.apply(ctx, sections.peakValley)
  registerService(ctx, { candidates: sections.candidates, history: sections.history })

  // 本插件自带一页 OhMyDSH 设置，关掉宿主按 schema 自动生成的那一份，避免两处编辑同一批字段。
  ctx.inject(['settings'], child => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'oh-my-dsh: own settings page',
    )
  })
}
