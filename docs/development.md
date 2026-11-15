# OhMyDSH 开发文档

这份文档说明代码怎么分层、改一个功能该动哪个文件、宿主与浏览器两边各守什么约定、提交前怎么验证。要动代码或审 diff 时看它；产品边界看[产品文档](product.md)，装机与发布看[运维文档](operations.md)。

## 运行形态

一个插件包，同时跑在两个运行时里：

- **Host 半边**：`index.js` + `lib/`，在 Node 里执行，负责配置解析、路由对齐、候选生成、历史读取，通过 Typert Remote 暴露 `ohMyDsh` 服务（`candidates`、`history` 两个方法）。
- **浏览器半边**：`client.js` 单文件，由 `window.__ModuleLoader__.load` 加载，注册输入框槽位、快捷键观察与唯一一页设置。它不能 `import` 仓库里的 host 文件，只能用加载器给的 `require` 取 `react`、`react-dom`、`zod` 等宿主依赖。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `index.js` | Host 入口：`inject`、三段合并的 `Config`、`apply`（峰谷 + 服务 + 关掉宿主自动设置页）|
| `lib/peak-valley/index.js` | 峰谷宿主逻辑：配置摊平、15 秒巡检、轮次边界、手动改模型识别、状态落库 |
| `lib/peak-valley/period.js` | `HH:MM` 解析、时区换算、跨零点与周末判定 |
| `lib/peak-valley/state.js` | `routeAt` / `periodInfo`：唯一的时段决策点 |
| `lib/candidates/index.js` | 候选生成、按会话与日志长度去重、中止 |
| `lib/candidates/candidates.js` | 纯函数：重建请求消息、拼指令、解析输出 |
| `lib/history/index.js` | 读会话日志，按 `limit` 取用户消息 |
| `lib/history/history.js` | 纯函数：哪些消息算「用户亲手发的」 |
| `lib/remote.js` / `lib/typert.js` / `lib/service.js` | `ohMyDsh/*` 的 spec、宿主清单与服务注册 |
| `lib/shipped.js` | 从 DSH 安装目录解析 `@deepseek-ai/*` 与 `zod`，避免 link 安装时缺依赖 |
| `client.js` | 浏览器半边：峰谷开关、候选条、历史按键、合并设置页、`registerUi` |
| `cordis.patch.yml` | bundle 安装行与默认配置 |
| `tools/migrate-profile.py` | 把三个旧插件的 profile 配置迁成 `oh-my-dsh` 一段 |
| `test/*.mjs` | 纯函数、宿主替身、jsdom 真实渲染三档测试 |

## 逻辑入口：新增或修改功能改哪里

1. 配置字段：在对应 `lib/*/index.js` 的 `Config` 里加字段，设置页要改的标 `.volatile()`，同步 `cordis.patch.yml` 的默认值。
2. 宿主逻辑：放在 `lib/<功能>/`，纯规则抽成无 I/O 的函数，方便单测。
3. 浏览器要用宿主数据：在 `lib/remote.js` 加方法 spec、`lib/typert.js` 加清单、`lib/service.js` 加 `@Remote` 方法，并在 `client.js` 里同步同一份 spec（浏览器侧不能引用 host 文件）。
4. 界面：在 `client.js` 对应 `register*` 里注册槽位，文案同时写中文与英文两份字典；功能开关接 `writeSection(form, '<段名>', { enabled })`。
5. 合并设置页：新板块加进 `OhMyDshSettings` 的 `blocks`，标题、关闭提示、开关文案从该功能字典取。
6. 收尾：补测试，更新 `README.md` 字段表、`CHANGELOG.md` 与 `AGENTS.md` 的文档入口。

## 宿主 API 约定

- 配置只投影 `volatile` 字段给浏览器；静态字段改了要重载插件。不要把整份 `config` 再交给 `Config()` 校验——`apply` 收到的是已解析结果，volatile 字段是 `{ get() }` 引用，二次校验会直接加载失败。
- 峰谷动态只能走 `sessionController.selectModel`，且只在轮次之间写：`preStep` 已按 `model.current()` 定死这一步的路由，轮次中途改会把别的路由的 `tool_use` 重放过去（thinking 签名不可移植）。换路由时不带 `reasoningEffort`。
- 用户手动换模型视为收回控制权：只关掉该会话的开关并记 `lastToggle`，不波及其他会话。
- 子代理会话不对齐；候选与历史都不写会话日志。
- 宿主版本要求与依赖解析方式见[运维文档](operations.md#运行形态与环境)。

## 技术选型与取舍

- **一个包而不是三个**：否决三包并行——三次挂载、三个服务、导航三页、配置三处。代价是 `client.js` 变大，合并层要自己写契约测试。
- **Typert Remote 而不是自建通道**：沿用宿主已有的远程方法协议，浏览器侧 `ctx.remote.ohMyDsh.*` 直接可用；否决 HTTP/IPC 自建。
- **Schemastery schema 而不是手写校验**：与宿主设置页共用同一套投影与写入机制。
- **纯 ESM、无构建**：`exports` 直接指向源文件，装到 profile 即可跑；否决引入 bundler 与产物目录。
- **jsdom + React 18 真实渲染**：候选条、开关、设置页的行为用点击验证；否决只做字符串快照。

## 验证与门禁

```bash
npm install   # devDependencies：react / react-dom / jsdom / zod / schemastery / typert-protocol
npm test      # node --test --test-force-exit test/*.test.mjs，2026-11-14 为 95 个用例
npm run check # node --check 逐个检查 9 个入口文件
```

三档测试：`period`/`state`/`history`/`candidates` 是纯函数；`peak-valley-host` 用替身跑宿主对齐；`peak-valley-client`/`peak-valley-interaction`/`merge` 在 jsdom 里真的渲染与点击。仓库没有 lint、类型检查或 CI 配置（是否要加见「待确认」）。

## 常见改错方式

- 给 `apply` 的配置再做一次 `Config(config)`，插件直接加载失败。
- 新字段忘了 `.volatile()`，设置页能显示但写不进去。
- 只改 `lib/remote.js` 忘了 `client.js` 里的同名 spec，浏览器调用报参数校验错误。
- 槽位 id 没挂 `oh-my-dsh.*` 前缀，或 `settings.section` 注册了第二页，导航里出现重复入口。
- 只改中文字典，英文界面缺文案。
- 为了让峰谷「立即生效」去改 `agent/request`，被宿主判成路由冲突。

## 开发历史

- 2026-11-12：单提交 `93ef922` 把三个插件合并成一个包。Host 三个服务合成 `ohMyDsh` 一个；浏览器侧一次 `$mount`；槽位统一 `oh-my-dsh.*`；配置分三段并各加 `enabled`；新增 `history.limit`（来源：提交与 CHANGELOG）。
- 2026-11-12：三个设置页合成一页、开关统一成胶囊控件、输入历史只收 `user` 来源；这部分改动 2026-11-14 20:06 提交（`97cd3dd`、`90c1d78`；来源：提交记录，对应[产品文档](product.md#产品发展历史)的三条反馈）。

## 待确认

- `client.js` 已 2593 行（2026-11-14），是否按功能拆文件？当前受「浏览器半边单文件加载」限制，拆分需要加载器支持。
- 是否引入 lint、类型检查与 CI；目前门禁只有测试与 `node --check`。
- `locale/*.json` 的描述仍写「每个功能在自己的设置页」、`index.js` 头注释仍写「三个功能的设置页各占一页」，落后于已提交的单页实现（`97cd3dd`）；它们是插件资源与代码注释，尚未同步。

## 不写在本文档的内容

- 产品定位、能力边界与误解：见[产品文档](product.md)。
- 安装卸载、版本兼容、设置迁移、发布回滚与排障：见[运维文档](operations.md)。
- 面向用户的安装与字段表：见 [README](../README.md)。
