/**
 * 「峰谷动态」的时段规则（纯粹函数，无 I/O）。
 *
 * v0.11 起时段来自配置：`peakWindows` 是「时间区间 + 对应模型」的列表，
 * 未命中任何区间时用 `offPeakRoute`。插件本身不是模型，模型列表里不出现。
 */

import { windowAt, zonedParts } from './period.js'

/**
 * 某个瞬间应使用的真实路由 —— 全部规则集中在这一个纯函数里。
 * @param cfg 插件配置（需要 peakWindows、offPeakRoute、timeZone）。
 * @param now 判定时刻。
 * @returns {{provider: string, model: string}} 目标路由。
 */
export function routeAt(cfg, now = new Date()) {
  const hit = windowAt(cfg.peakWindows, now, cfg.timeZone)
  if (hit !== undefined) return hit.route
  return cfg.offPeakRoute
}

/**
 * 供界面展示的「当前时段」描述。
 * @param cfg 插件配置。
 * @param now 判定时刻。
 * @param format 把分钟格式化成 `HH:MM` 的函数，默认原样返回。
 * @returns {{inWindow: boolean, label: string, route: {provider: string, model: string}}}
 */
export function periodInfo(cfg, now = new Date(), format = (minutes) => String(minutes)) {
  const hit = windowAt(cfg.peakWindows, now, cfg.timeZone)
  if (hit === undefined) {
    return { inWindow: false, label: 'off-peak', route: cfg.offPeakRoute }
  }
  return {
    inWindow: true,
    label: `${format(hit.start)}-${format(hit.end)}`,
    route: hit.route,
  }
}

export { zonedParts }
