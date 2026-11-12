/**
 * 纯粹规则面：时段判定与配置摊平。
 *
 * v0.6 起插件不再是模型，规则只剩「什么时候用哪条真实路由」，
 * 开关本身由配置布尔值决定，不在这个模块里推导。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, readConfig } from '../lib/peak-valley/index.js'
import { periodInfo, routeAt } from '../lib/peak-valley/state.js'
import { formatClock } from '../lib/peak-valley/period.js'

const PEAK = { provider: 'p-peak', model: 'm-peak' }
const OFF = { provider: 'deepseek-account', model: 'deepseek-flash' }
const CFG = {
  enabled: true,
  timeZone: 'Asia/Shanghai',
  offPeakRoute: OFF,
  peakWindows: [
    { start: '09:00', end: '12:00', ...PEAK },
    { start: '14:00', end: '18:00', ...PEAK },
  ],
}

const at = (iso) => new Date(iso)

test('routeAt 命中时段时用该时段自己的模型', () => {
  assert.deepEqual(routeAt(CFG, at('2026-11-02T10:00:00+08:00')), PEAK)
})

test('routeAt 下午时段也命中', () => {
  assert.deepEqual(routeAt(CFG, at('2026-11-02T15:00:00+08:00')), PEAK)
})

test('routeAt 午休落在窗口外，用 offPeakRoute', () => {
  assert.deepEqual(routeAt(CFG, at('2026-11-02T12:30:00+08:00')), OFF)
})

test('routeAt 晚间与夜间落在窗口外', () => {
  assert.deepEqual(routeAt(CFG, at('2026-11-02T20:00:00+08:00')), OFF)
  assert.deepEqual(routeAt(CFG, at('2026-11-02T03:00:00+08:00')), OFF)
})

test('routeAt 周末全天落在窗口外', () => {
  assert.deepEqual(routeAt(CFG, at('2026-10-31T10:00:00+08:00')), OFF)
})

test('periodInfo 给出命中的区间与使用的模型', () => {
  const info = periodInfo(CFG, at('2026-11-02T10:00:00+08:00'), formatClock)
  assert.equal(info.inWindow, true)
  assert.equal(info.label, '09:00-12:00')
  assert.deepEqual(info.route, PEAK)

  const outside = periodInfo(CFG, at('2026-11-02T22:00:00+08:00'), formatClock)
  assert.equal(outside.inWindow, false)
  assert.deepEqual(outside.route, OFF)
})

test('自定义时段：改时间与模型都立即生效', () => {
  const custom = {
    ...CFG,
    peakWindows: [{ start: '20:00', end: '22:00', provider: 'x', model: 'night-model' }],
  }
  assert.deepEqual(routeAt(custom, at('2026-11-02T21:00:00+08:00')), { provider: 'x', model: 'night-model' })
  assert.deepEqual(routeAt(custom, at('2026-11-02T10:00:00+08:00')), OFF, '原来的峰时已不在表内')
})

test('readConfig 摊平 volatile 字段并保留静态字段', () => {
  const flat = readConfig(Config({}))
  assert.deepEqual(flat.sessions, {}, 'sessions 是 volatile 引用对象，必须摊平')
  assert.equal(typeof flat.sessions, 'object')
  assert.equal(flat.timeZone, 'Asia/Shanghai')
  assert.equal(Array.isArray(flat.peakWindows), true, 'peakWindows 必须摊平成数组')
  assert.equal(flat.peakWindows.length, 2, '默认两段')
  assert.deepEqual(flat.peakWindows[0], {
    start: '09:00',
    end: '12:00',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  assert.deepEqual(flat.offPeakRoute, { provider: 'deepseek-account', model: 'deepseek-flash' })
})

test('readConfig 对空配置也能给出可用路由', () => {
  const flat = readConfig(undefined)
  assert.equal(typeof routeAt(flat).provider, 'string')
  assert.equal(routeAt(flat, at('2026-11-02T10:00:00+08:00')).provider, 'deepseek-account')
})

test('设置页要改的字段都是 volatile（浏览器才能读写）', () => {
  const parsed = Config({})
  for (const field of ['sessions', 'peakWindows', 'offPeakRoute', 'timeZone']) {
    assert.equal(typeof parsed[field].get, 'function', `${field} 必须是 volatile`)
  }
})

test('配置里不再有 exitRoute（关闭开关不再切目标）', () => {
  assert.equal(Config({}).exitRoute, undefined)
  assert.equal(JSON.stringify(Config.toJSON()).includes('exitRoute'), false)
})
