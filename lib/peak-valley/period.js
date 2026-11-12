/**
 * 时段判定的纯函数（无副作用、无 I/O）。
 *
 * v0.11 起时段不再硬编码：`Config.peakWindows` 是「时间区间 + 对应模型」的列表，
 * 落在任一区间内就用该区间的模型，其余时间用 `offPeakRoute`。
 *
 * 约定：
 *  - 区间写作 `HH:MM`，左闭右开 `[start, end)`；
 *  - `end` 早于或等于 `start` 视为跨零点（如 22:00–02:00）；
 *  - 区间只在工作日生效，周末整天走 `offPeakRoute`（与官方按工作日定价一致）；
 *  - 判定按「参考时区」，不是机器本地时区；Intl 负责夏令时与任意 IANA 时区。
 */

/** 默认参考时区：峰谷价按 DeepSeek 官方北京时间定义。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** 一天的分钟数。 */
const DAY_MINUTES = 24 * 60

/**
 * 把某个瞬间换算到参考时区的“星期 + 当日分钟”。
 *
 * @param {Date} instant 要换算的瞬间。
 * @param {string} timeZone IANA 时区名。
 * @returns {{day: number, minute: number}} day 为 0=周日 … 6=周六。
 */
export function zonedParts(instant, timeZone = DEFAULT_TIME_ZONE) {
  // UTC+8 算术兜底：Asia/Shanghai 自 1991 年起无夏令时，与真实时间等价。
  const fallback = () => {
    const shifted = new Date(instant.getTime() + 8 * 60 * 60 * 1000)
    return { day: shifted.getUTCDay(), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() }
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant)
    const pick = (type) => parts.find((part) => part.type === type)?.value
    const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const day = days[pick('weekday')]
    const hour = Number(pick('hour'))
    const minute = Number(pick('minute'))
    // 非法 IANA 名会让构造函数抛 RangeError；精简 ICU 则可能给出不可用的面。
    if (day === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return fallback()
    return { day, minute: hour * 60 + minute }
  } catch {
    return fallback()
  }
}

/**
 * 解析 `HH:MM` 为当日分钟。
 *
 * 也接受 `H:MM`，方便手写配置；越界或格式不对返回 undefined。
 * @param {unknown} text 待解析文本。
 * @returns {number | undefined} 0…1439，或 undefined。
 */
export function parseClock(text) {
  if (typeof text !== 'string') return undefined
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/u.exec(text)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 把当日分钟格式化成 `HH:MM`。 */
export function formatClock(minutes) {
  const hour = Math.floor(minutes / 60) % 24
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * 判断某个当日分钟是否落在区间内（左闭右开，支持跨零点）。
 * @param {number} minute 当日分钟。
 * @param {number} start 起始分钟。
 * @param {number} end 结束分钟。
 */
function within(minute, start, end) {
  if (start === end) return false
  if (start < end) return minute >= start && minute < end
  // 跨零点：22:00–02:00 表示 >=22:00 或 <02:00。
  return minute >= start || minute < end
}

/**
 * 规范化一个配置里的时间区间。
 *
 * 时间无法解析时返回 undefined，让调用方跳过该条而不是抛错 —— 一份手写配置里
 * 写错一行，不应该让整个插件失效。
 * @param {unknown} raw 配置里的原始条目。
 * @returns {{start: number, end: number, route: {provider: string, model: string}} | undefined}
 */
export function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const start = parseClock(raw.start)
  const end = parseClock(raw.end)
  if (start === undefined || end === undefined) return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { start, end, route: { provider, model } }
}

/**
 * 找出某个瞬间命中的时段。
 *
 * 周末整天不命中（走窗口外路由），与官方按工作日定价一致。
 * @param {readonly unknown[]} windows 配置里的 `peakWindows`。
 * @param {Date} instant 要判断的瞬间。
 * @param {string} timeZone 参考时区。
 * @returns {{index: number, start: number, end: number, route: {provider: string, model: string}} | undefined}
 */
export function windowAt(windows, instant, timeZone = DEFAULT_TIME_ZONE) {
  if (!Array.isArray(windows)) return undefined
  const { day, minute } = zonedParts(instant, timeZone)
  if (day === 0 || day === 6) return undefined
  for (let index = 0; index < windows.length; index += 1) {
    const normalized = normalizeWindow(windows[index])
    if (normalized === undefined) continue
    if (within(minute, normalized.start, normalized.end)) {
      return { index, ...normalized }
    }
  }
  return undefined
}

/**
 * 距离下一个时段边界的分钟数（用于说明“还有多久切换”）。
 *
 * 只在工作日计算，周末返回 undefined。找不到更晚的边界时回绕到次日第一段的起点。
 * @param {readonly unknown[]} windows 配置里的 `peakWindows`。
 * @param {Date} instant 参考瞬间。
 * @param {string} timeZone 参考时区。
 * @returns {number | undefined} 分钟数。
 */
export function minutesToNextBoundary(windows, instant, timeZone = DEFAULT_TIME_ZONE) {
  if (!Array.isArray(windows)) return undefined
  const { day, minute } = zonedParts(instant, timeZone)
  if (day === 0 || day === 6) return undefined
  const points = []
  for (const raw of windows) {
    const normalized = normalizeWindow(raw)
    if (normalized === undefined) continue
    points.push(normalized.start, normalized.end)
  }
  if (points.length === 0) return undefined
  const later = points.filter((point) => point > minute).sort((a, b) => a - b)
  if (later.length > 0) return later[0] - minute
  return DAY_MINUTES - minute + Math.min(...points)
}
