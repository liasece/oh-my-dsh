/** Host 装配入口。各功能从同一页设置读取自己的配置段。 */
import { importShipped } from './lib/shipped.js'
import * as peakValley from './lib/peak-valley/index.js'
import * as candidates from './lib/candidates/index.js'
import * as history from './lib/history/index.js'
import * as sessionCreation from './lib/session-creation/index.js'
import { registerService } from './lib/service.js'

const [{ default: Schema }] = await Promise.all([importShipped('@deepseek-ai/schemastery')])

export const name = 'oh-my-dsh'

export const inject = ['llm', 'sessions', 'typert']

export const Config = Schema.object({
  peakValley: peakValley.Config,
  candidates: candidates.Config,
  history: history.Config,
  sessionCreation: sessionCreation.Config,
})

/**
 * @param ctx 宿主上下文。
 * @param config 已解析的配置；设置页能写的字段是活引用，读值时再取。
 */
export function apply(ctx, config) {
  const sections = {
    peakValley: config?.peakValley ?? {},
    candidates: config?.candidates ?? {},
    history: config?.history ?? {},
  }

  peakValley.apply(ctx, sections.peakValley)
  registerService(ctx, { candidates: sections.candidates, history: sections.history })
  sessionCreation.apply(ctx, config?.sessionCreation)

  // 本插件自带一页 OhMyDSH 设置，关掉宿主按 schema 自动生成的那一份，避免两处编辑同一批字段。
  ctx.inject(['settings'], child => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'oh-my-dsh: own settings page',
    )
  })
}
