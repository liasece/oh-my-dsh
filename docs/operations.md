# OhMyDSH 运维文档

这份文档说明 OhMyDSH 装在哪、依赖什么、怎么升级回滚、出问题先看什么。要发布、迁移旧插件或排查异常时看它；代码结构看[开发文档](development.md)，产品边界看[产品文档](product.md)。

## 运行形态与环境

- 没有自建主机、域名证书、数据库、对象存储或第三方 API 密钥。插件跑在 DSH 进程内：Host 半边用 Node，浏览器半边在 Desktop / Web 的客户端槽位里；模型路由只写会话的 provider/model，密钥由 DSH 自己的 provider 配置持有。
- 界面只存在于 DSH Desktop 或 Web，TUI 没有这些槽位。
- Node `>=22`；DSH 版本区间写在 `package.json` 的 `engines.dsh`（当前 `>=0.2.2-rc.1 <0.3.0`，2026-11-14 核对；本机 DSH 为 0.2.2-rc.1）。
- 不需要构建。`npm install` 只装开发与测试依赖。

## 安装与卸载

安装走插件管理器，把本机 checkout 作为 bundle 装进当前 profile，命令与参数见 [README 的「安装」节](../README.md#安装)。新 bundle 要重启 DSH 才加载；之后改配置、开关功能都不用重启。装好后 profile 里会出现三处：`cordis.patch.yml` 的 `- id: oh-my-dsh` 行、`package.json` 的 `dependencies`（本机是 `link:/Users/jansen/src/liasece/oh-my-dsh`）、`dsh.profile.bundles` 里的 `oh-my-dsh`。profile 目录在 `~/.dsh/profiles/<desktop|web|headless>/`；本机 desktop 已装，web 与 headless 没有这一项（2026-11-14 观察）。

卸载：从插件管理器移除，或手工删掉上面三处后重启。配置段可以保留，不装插件时不生效，不需要为了卸干净去改历史配置。

## 配置与热更新

设置页能改的字段都是 `volatile`，写完即时生效；标了「静态字段」的要重载插件或重启 DSH。字段表与标注见 [README 的配置节](../README.md#配置)。

## 升级、发布与回滚

- 本机是 `link:` 安装：改完代码重启 DSH 即生效，回滚就是把 checkout 切回上一个提交再重启。
- 对外分发不走 npm 发布：npm 上的 `oh-my-dsh` 属于另一个项目（`amplifthq/oh-my-dsh`，最新 0.1.7，2026-11-14 核对），不能直接 `npm publish` 这个名字。实际渠道是自建插件索引 [liasece/dsh-plugins](https://github.com/liasece/dsh-plugins) 的 `market.json`（格式 1），按 git commit SHA 定位版本。
- 发布顺序：改代码并升 `package.json` 版本 → 提交推送插件仓库（不改写已发布历史）→ 取 `git rev-parse HEAD` → 在 `market.json` 的 `versions` 追加版本、`publishTimestamp`（该提交的 Unix 秒）与完整 SHA，旧版本条目保留 → 在索引仓库 `pnpm run validate` 通过后提交推送。
- 回滚：索引保留旧版本，用户可装回旧版；本机切回旧提交并重启。
- 发布前先过[开发文档的验证命令](development.md#验证与门禁)；仓库目前没有 CI 自动跑这些检查。

## 从三个旧插件迁移

`tools/migrate-profile.py <profile 目录>` 把旧 `peak-valley-model` 行换成 `oh-my-dsh`，把 `sessions`/`lastToggle` 搬进 `peakValley`，删掉废弃的 `timeline` 与旧 `enabled`，同时改写 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`。字段对照见 [README 的迁移节](../README.md#从三个旧插件迁移)。

注意：脚本头注释写了 `--dry-run`，但 `main()` 只读第一个参数，并不会跳过写入——运行前先备份 profile 的两个文件。脚本把依赖写成 `link:<本仓库路径>`，迁移后仍需重启 DSH 让新 bundle 行生效。

## 日志与监控

没有独立监控。可用线索：DSH Host 终端输出（`ctx.logger` 的 warn/info，候选失败会打 `candidates failed: …`）、设置页的 `debug` 开关（把候选请求的用量与原始输出打到 Host 终端）、浏览器开发者工具的 console（`[oh-my-dsh] request failed`）。会话与附件在 `~/.dsh/` 下，日志目录是 `~/.dsh/logs/`。

## 故障排查

| 症状 | 先看什么 | 常见原因 |
| --- | --- | --- |
| 设置里没有 OhMyDSH | profile 的 `dsh.profile.bundles` 是否有 `oh-my-dsh`；是否重启过 | 新 bundle 没加载；装到了别的 profile |
| 设置页只读 | 宿主是否提供可写配置层；页面顶部提示 | 部署禁用了配置写入 |
| 峰谷开了但不换模型 | 会话开关是否打开；当前是否周末或午休；两段路由是否与谷时相同 | 默认关、默认路由相同、非工作时段 |
| 跨过时段边界后模型位没换 | 是否在 15 秒巡检间隔内；是否正跑一轮 | 巡检上限 15 秒；轮次中途不切 |
| 候选一直不出现 | 功能开关；回合是否已结束；`debug` 输出 | 关掉了、回合未结束、超时或模型返回空 |
| ↑ 没反应 | 草稿是否为空；光标是否在首/末行；功能开关 | 多行草稿把 ↑ 留给光标；功能关闭 |

## 运维历史

- 2026-11-12：插件在 desktop profile 以 `link:` 方式安装，替代原来的三个插件；自建索引收录 0.1.0（commit `93ef922`）（来源：profile 配置、`dsh-plugins/market.json`）。
- 2026-11-12：单页设置与输入历史过滤的改动已进工作区但未提交，索引里的 0.1.0 仍是旧行为（2026-11-14 观察）。

## 待确认

- npm 包名冲突如何处理：改名、继续只在自建索引分发，还是向 npm 申请？
- 是否给 `package.json` 的 `files` 加上 `docs/`（当前不含，将来发布 npm 时文档不会随包走）。
- profile 里累积的会话级峰谷开关是否需要清理：合并提交称当时迁移了 91 个，2026-11-14 观察到 101 个。
- `tools/migrate-profile.py` 的 `--dry-run` 是补实现还是从注释里删掉。

## 不写在本文档的内容

- 产品定位、能力边界与误解：见[产品文档](product.md)。
- 目录职责、宿主 API 约定、测试与门禁：见[开发文档](development.md)。
- 配置字段表与用户安装说明：见 [README](../README.md)。
