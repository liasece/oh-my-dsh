# OhMyDSH

OhMyDSH 提供峰谷模型路由、提示词候选、输入历史和会话创建。你可以在 DSH 里直接让 agent 开一个新会话，把任务交过去，再从侧栏接着聊。

所有功能共用一个插件包和一页 **OhMyDSH** 设置，各有独立开关。

| 功能 | 做什么 | 界面位置 | 开关 |
| --- | --- | --- | --- |
| 峰谷动态 | 在配置的时段里把会话的**模型位**换成时段路由，时段外用另一条 | 输入框右侧的开关；设置 → OhMyDSH → 峰谷动态 | 输入框开关（按会话）+ 板块头的胶囊开关 |
| 提示词候选 | 回合结束后用当前模型生成几条候选，点一下填进输入框 | 输入框上方候选条；设置 → OhMyDSH → 提示词候选 | 板块头的胶囊开关 |
| 输入历史 | 草稿为空时按 ↑ 逐条往回翻自己发过的消息，↓ 往前翻；Esc 收起，Enter 发送 | 无可见界面（纯键盘）；设置 → OhMyDSH → 输入历史 | 板块头的胶囊开关 |
| 会话创建 | agent 按要求新开一个会话，并把首条任务交给它 | 对话中的 `create_session` 工具，结果出现在 DSH 侧栏 | 设置 → OhMyDSH → 会话创建 |

## 安装

插件以 bundle 形式安装到当前 profile。在 DSH 会话里调用 `plugin_manager`：

```json
{ "action": "install_bundle", "target": "/path/to/oh-my-dsh" }
```

`target` 换成本机 checkout 的绝对路径。仓库是纯 ESM，不需要构建。

或者从自建插件索引 [liasece/dsh-plugins](https://github.com/liasece/dsh-plugins) 里安装 `oh-my-dsh`；索引按 commit SHA 记录版本，发布与回滚流程见[运维文档](docs/operations.md#升级发布与回滚)。

新装的 bundle 需要**重启 DSH** 才会加载（运行中的应用不能热加载新的 bundle 行）。之后改配置、开关功能都不需要再重启。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里，每段各管一个功能。设置页能改的字段都是 `volatile`，写完即时生效。

```yaml
- id: oh-my-dsh
  name: oh-my-dsh
  config:
    peakValley:
      enabled: true
      timeZone: Asia/Shanghai
      peakWindows:
        - { start: '09:00', end: '12:00', provider: deepseek-account, model: deepseek-flash }
        - { start: '14:00', end: '18:00', provider: deepseek-account, model: deepseek-flash }
      offPeakRoute: { provider: deepseek-account, model: deepseek-flash }
      sessions:
        <session-id>: true
      lastToggle: { on: false, at: 0 }
    candidates:
      enabled: true
      maxSuggestions: 2
      historyMessages: 12
    history:
      enabled: true
      limit: 100
    sessionCreation:
      enabled: true
```

### `peakValley`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 整个功能的总开关。关掉后既不对齐模型位，也不响应手动换模型。 |
| `timeZone` | `Asia/Shanghai` | 判断「现在是不是峰时」用的时区；设置页可改，保存即时生效。 |
| `peakWindows` | 09:00–12:00、14:00–18:00 两段，路由同谷时 | 每段自带 `provider` / `model`。周末一律算谷时。默认两条路由相同，所以装好等于不切换，要到设置页把峰时那两段换成你的另一条路由。 |
| `offPeakRoute` | `deepseek-account` / `deepseek-flash` | 时段之外（含周末）使用的路由，`{ provider, model }`。 |
| `sessions` | `{}` | 按会话的开关状态。**默认不开**：新会话要自己打开。 |
| `lastToggle` | `{ on: false, at: 0 }` | 最近一次手动动作，用来决定新建会话继承「开」还是「关」。 |

官方 provider 有两个：`llm-deepseek-account` 注册 `deepseek-account`（桌面端账号登录），`llm-deepseek-api-key` 注册 `deepseek-official`（API Key 部署）。

### `candidates`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不再请求候选。 |
| `maxSuggestions` | `2` | 一次最多几条候选，1–5。模型可以给得更少。 |
| `historyMessages` | `12` | 送给模型的最近消息条数，1–40；最近的用户消息一定会带上。 |
| `maxOutputTokens` | `1600` | 候选请求的输出上限（推理模型的思考也算在内）。静态字段。 |
| `timeoutMs` | `25000` | 一次候选请求的端到端时限。静态字段。 |
| `provider` / `model` | 空 | 可选的路线覆盖；两者都填才生效，否则沿用会话当前模型。静态字段。 |
| `debug` | `false` | 把原始输出打到 Host 终端。静态字段。 |

### `history`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后 ↑／↓ 不再被插件接管，编辑器恢复原生行为。 |
| `limit` | `100` | 一次最多往回翻多少条自己发过的消息，1–200；助手、子 Agent 与框架注入的消息不占条数。 |

### `sessionCreation`

`enabled` 默认是 `true`。关掉后，agent 无法继续创建会话，已经创建的会话仍能照常使用。

## 从三个旧插件迁移

字段是一一对应的，只是多套了一层段名：峰谷动态的 `enabled`/`sessions`/`peakWindows`/`offPeakRoute`/`timeZone` 前面加 `peakValley:`，提示词候选的字段前面加 `candidates:`，输入历史加 `history:`。

步骤：

1. 把 `cordis.patch.yml` 里 `peak-valley-model` 那一行替换成 `oh-my-dsh`，把原来的 `config` 原样搬到 `peakValley:` 下面。旧的 `timeline` 字段（0.20 之前的遗留）不用搬，现在由 `peakWindows` 决定。
2. 提示词候选的配置原来在它自己的 bundle 里，搬到 `candidates:` 下面；输入历史搬到 `history:` 下面。
3. 从 `dsh.profile.bundles` 和 profile 的 `dependencies` 里删掉三个旧包，装上 `oh-my-dsh`。
4. 重启 DSH。

`lastToggle` 一定要一起搬：它记着「最近一次动作是开还是关」，决定新会话的默认状态。丢掉它，新会话会退回「关」。

## 行为细节

### 会话创建

在普通会话里说「新开一个叫『文档审阅』的会话，让它检查 README 的安装步骤」。新会话会在当前项目的侧栏出现，独立处理第一条任务。你可以继续当前对话，也可以打开新会话接着问。创建结果包含标题、`sessionId` 和首条任务是否已交付的 `started`。

侧栏按工作区分组时，在目标项目下找新会话。「最近更新」先显示置顶会话，普通会话按创建或最近一次用户发言的时间排序。工作区保留原有顺序。要跨项目按时间查看，可在侧栏「视图选项」里选「单列表」和「最近更新」。使用「手动排序」时，后台新建的普通会话排在已有手动顺序之后。

`create_session` 接受必填的 `prompt`、可选的 `title` 和 `workspace`。缺省标题取自首条任务。默认沿用发起会话的项目、工作目录、模型、agent 预设和权限。用户明确指定其他已有项目时，按项目名、完整路径或 ID 选择，使用该项目的根目录。移到当前沙箱可写范围以外的项目并获得写权限，需要 DSH 批准。

只有普通会话里由用户本人发起的回合能创建新会话。子代理、计划模式和访客回合不能启动这个操作。新会话从独立的对话历史开始，第一条消息注明来自发起 agent。临时分工仍可用 DSH 内置的子代理。

### 峰谷动态

- 开关是**按会话**的，没有全局默认开。`lastToggle` 只影响新建会话的那一次继承。设置页可以一键清空所有会话的覆盖。
- 路由靠**改写会话的模型位**（`sessionController.selectModel`）实现，不拦请求、不改 `agent/request`。改请求会被 Harness 判成 `proposed X after step preparation fixed Y` 并报错。
- 换路由时丢掉承自原模型的 `reasoningEffort`，避免把不支持的强度硬套到另一条路由。
- 用户手动换模型 → 这个会话自动关掉（只删这个会话的键，并记一次 `lastToggle`）。
- 对齐时机：插件启动、每 15 秒巡检、每轮结束、开关变更。轮次中途到点不切，等这一轮结束再切，避免同一轮前后换路由。
- 子代理会话不对齐。

### 提示词候选

- 只在会话停在已结束的回合时生成；同一会话按日志长度去重，不会重复请求。
- Tab 只在 composer 卡片内被消费，采纳走 `inputActions.captureInsertion()` + `insertText()`。会话日志零写入。
- 用的是会话当前模型（或用 `provider`/`model` 覆盖），一次请求 `maxOutputTokens` 上限，超时按 `timeoutMs` 放弃。

### 输入历史

- 只在「草稿为空」且光标在首行/末行时接管 ↑／↓；多行草稿里把方向键留给光标移动。
- 读的是**你自己发出去的消息文本**（wire text）；助手消息、子 Agent 的 `agent-message`、运行时上下文／技能目录／压缩摘要等框架注入内容都不参与召回，也不占召回条数。带文件引用的消息召回后是 `@[标签](dsh-file:…)` 这种原文，不会还原成 chip；图片和附件不参与召回。
- 历史按会话隔离，只读，不写会话日志。

## 已知边界

- 输入历史召回的是线上文本，不是原始编辑态：`@` 引用的 chip、粘贴的图片都找不回来。
- 提示词候选和输入历史都是只读的旁观者；它们不会改会话内容，也不会替你发消息。输入历史只读会话日志，不请求模型、不消耗模型额度；提示词候选每回合结束会请求一次模型，不需要时可在 OhMyDSH 页关掉。
- 峰谷动态依赖「模型位」这条路：如果某个 provider 的模型不在 `modelCatalog` 里，设置页会保留配置值但无法选中它。
- 输入框控件和设置页使用 DSH Desktop / Web 的客户端槽位。会话创建工具在宿主执行。

## 开发

```bash
npm install                # 需要 react / react-dom / jsdom / zod / @deepseek-ai/schemastery
npm test                   # node --test test/*.test.mjs
```

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 入口，装配各功能及其配置 |
| `lib/peak-valley/index.js` | 峰谷动态的宿主半边：配置摊平、路由对齐、手动改动记账 |
| `lib/peak-valley/period.js` | 时段解析与「现在在哪一档」 |
| `lib/peak-valley/state.js` | `routeAt(cfg, now)`：唯一的时段决策点 |
| `lib/candidates/index.js` | 提示词候选的宿主半边：生成、去重、缓存 |
| `lib/candidates/candidates.js` | 纯函数：重建请求消息、解析输出 |
| `lib/history/index.js` | 输入历史的宿主半边：读会话文本 |
| `lib/session-creation/` | 注册 agent 工具，创建普通会话并投递首条任务 |
| `lib/remote.js` / `lib/typert.js` | Typert Remote 的 spec 与 manifest |
| `lib/service.js` | 服务 `ohMyDsh` 的两个方法 |
| `client.js` | 浏览器半边，提供输入框槽位与 OhMyDSH 设置页 |
| `cordis.patch.yml` | bundle 的安装行 |

测试分三档：`period`/`state`/`history`/`candidates` 是纯函数，`peak-valley-host` 用替身跑宿主逻辑，`peak-valley-client`/`peak-valley-interaction`/`merge` 用 jsdom + React 18 真的渲染和点击。

## 文档

- [产品文档](docs/product.md)：各项功能的使用场景、能力边界与产品历史。
- [开发文档](docs/development.md)：Host / 浏览器两半边的分层、改动落点、宿主 API 约定与测试。
- [运维文档](docs/operations.md)：安装卸载、版本兼容、设置迁移、发布回滚与排障。
- [AGENTS.md](AGENTS.md)：给 agent 的文档入口与工作约定。

文档按问题选读，不是使用插件的前置步骤。

## 许可

MIT。
