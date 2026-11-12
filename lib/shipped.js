/**
 * 从 Harness 安装目录导入随包发布的运行时包（`@deepseek-ai/*`、`zod`）。
 *
 * 以目录链接方式装入 profile 的 bundle，其自身目录里没有这些依赖；而 Host
 * 进程总是由安装目录内的脚本启动（`process.argv[1]`），因此从该锚点解析
 * 得到的副本与 Harness 自己加载的是同一份。ESM 入口显式选择：`require.resolve`
 * 会命中 CommonJS 孪生文件，类身份与 Host 不一致。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function esmEntry(exportsField, main) {
  let target = exportsField && typeof exportsField === 'object' && '.' in exportsField ? exportsField['.'] : exportsField
  while (target && typeof target === 'object') target = target.import ?? target.default ?? target.node
  return typeof target === 'string' ? target : (main ?? 'index.js')
}

function resolveFromInstallation(specifier) {
  const anchor = process.argv[1]
  if (!anchor) return undefined
  for (const base of createRequire(anchor).resolve.paths(specifier) ?? []) {
    const dir = join(base, specifier)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    return pathToFileURL(join(dir, esmEntry(pkg.exports, pkg.main))).href
  }
  return undefined
}

/**
 * 优先使用安装目录内的副本；找不到时回退普通解析（覆盖从 registry 安装、
 * 自带依赖的情况）。
 * @param specifier - 裸包名。
 * @returns 模块命名空间。
 */
export async function importShipped(specifier) {
  const url = resolveFromInstallation(specifier)
  return await import(url ?? specifier)
}
