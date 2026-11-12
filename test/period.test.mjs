/**
 * 时段判定的纯函数测试。
 *
 * v0.11 起时段来自配置，所以这里守「解析 / 命中 / 跨零点 / 周末」这些规则。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatClock,
  minutesToNextBoundary,
  normalizeWindow,
  parseClock,
  windowAt,
  zonedParts,
} from '../lib/peak-valley/period.js'

const TZ = 'Asia/Shanghai'
const at = (iso) => new Date(iso)

/** 官方默认的两段式。 */
const WINDOWS = [
  { start: '09:00', end: '12:00', provider: 'p', model: 'peak' },
  { start: '14:00', end: '18:00', provider: 'p', model: 'peak' },
]

test('parseClock 接受 HH:MM 与 H:MM，拒绝越界与乱码', () => {
  assert.equal(parseClock('09:00'), 540)
  assert.equal(parseClock('9:05'), 545)
  assert.equal(parseClock('00:00'), 0)
  assert.equal(parseClock('23:59'), 1439)
  assert.equal(parseClock('24:00'), undefined)
  assert.equal(parseClock('09:60'), undefined)
  assert.equal(parseClock('abc'), undefined)
  assert.equal(parseClock(undefined), undefined)
  assert.equal(parseClock(540), undefined)
})

test('formatClock 补齐两位', () => {
  assert.equal(formatClock(540), '09:00')
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(1439), '23:59')
})

test('normalizeWindow 丢弃写坏的条目而不是抛错', () => {
  assert.deepEqual(
    normalizeWindow({ start: '09:00', end: '12:00', provider: 'p', model: 'm' }),
    { start: 540, end: 720, route: { provider: 'p', model: 'm' } },
  )
  assert.equal(normalizeWindow({ start: 'bad', end: '12:00', provider: 'p', model: 'm' }), undefined)
  assert.equal(normalizeWindow({ start: '09:00', end: '12:00', provider: '', model: 'm' }), undefined)
  assert.equal(normalizeWindow(null), undefined)
})

test('工作日命中区间，边界左闭右开', () => {
  // 2026-11-02 是周一
  assert.equal(windowAt(WINDOWS, at('2026-11-02T09:00:00+08:00'), TZ)?.route.model, 'peak', '09:00 含在窗口内')
  assert.equal(windowAt(WINDOWS, at('2026-11-02T11:59:00+08:00'), TZ)?.route.model, 'peak')
  assert.equal(windowAt(WINDOWS, at('2026-11-02T12:00:00+08:00'), TZ), undefined, '12:00 整点已离开')
  assert.equal(windowAt(WINDOWS, at('2026-11-02T08:59:00+08:00'), TZ), undefined, '09:00 之前不命中')
  assert.equal(windowAt(WINDOWS, at('2026-11-02T13:59:00+08:00'), TZ), undefined, '午休不命中')
  assert.equal(windowAt(WINDOWS, at('2026-11-02T14:00:00+08:00'), TZ)?.route.model, 'peak')
  assert.equal(windowAt(WINDOWS, at('2026-11-02T18:00:00+08:00'), TZ), undefined, '18:00 整点已离开')
})

test('周末整天不命中（走窗口外路由）', () => {
  // 2026-10-31 周六、11-01 周日
  assert.equal(windowAt(WINDOWS, at('2026-10-31T10:00:00+08:00'), TZ), undefined)
  assert.equal(windowAt(WINDOWS, at('2026-11-01T15:00:00+08:00'), TZ), undefined)
})

test('跨零点的区间按 >=start 或 <end 命中', () => {
  const night = [{ start: '22:00', end: '02:00', provider: 'p', model: 'night' }]
  assert.equal(windowAt(night, at('2026-11-02T23:30:00+08:00'), TZ)?.route.model, 'night')
  assert.equal(windowAt(night, at('2026-11-02T01:30:00+08:00'), TZ)?.route.model, 'night', '凌晨仍算该区间')
  assert.equal(windowAt(night, at('2026-11-02T12:00:00+08:00'), TZ), undefined)
  assert.equal(windowAt(night, at('2026-11-02T02:00:00+08:00'), TZ), undefined, '02:00 整点结束')
})

test('start 等于 end 视为空区间，永不命中', () => {
  const empty = [{ start: '09:00', end: '09:00', provider: 'p', model: 'm' }]
  assert.equal(windowAt(empty, at('2026-11-02T09:00:00+08:00'), TZ), undefined)
})

test('同一时刻命中多段时取配置顺序里的第一条', () => {
  const overlap = [
    { start: '09:00', end: '12:00', provider: 'p', model: 'first' },
    { start: '10:00', end: '11:00', provider: 'p', model: 'second' },
  ]
  assert.equal(windowAt(overlap, at('2026-11-02T10:30:00+08:00'), TZ)?.route.model, 'first')
})

test('判定跟随参考时区而不是机器本地时区', () => {
  // 同一瞬间：北京 10:00 命中，UTC 02:00 不命中
  const instant = at('2026-11-02T10:00:00+08:00')
  assert.equal(windowAt(WINDOWS, instant, 'Asia/Shanghai')?.route.model, 'peak')
  assert.equal(windowAt(WINDOWS, instant, 'UTC'), undefined)
})

test('非法时区退化为 UTC+8 算术而不是抛错', () => {
  const instant = at('2026-11-02T10:00:00+08:00')
  assert.deepEqual(zonedParts(instant, 'Not/AZone'), { day: 1, minute: 600 })
})

test('minutesToNextBoundary 给出到下一个边界的分钟数', () => {
  assert.equal(minutesToNextBoundary(WINDOWS, at('2026-11-02T11:00:00+08:00'), TZ), 60, '12:00 还有 60 分钟')
  assert.equal(minutesToNextBoundary(WINDOWS, at('2026-11-02T12:30:00+08:00'), TZ), 90, '14:00 还有 90 分钟')
  assert.equal(minutesToNextBoundary(WINDOWS, at('2026-11-02T19:00:00+08:00'), TZ), 840, '回绕到次日 09:00')
  assert.equal(minutesToNextBoundary(WINDOWS, at('2026-10-31T10:00:00+08:00'), TZ), undefined, '周末不计算')
})
