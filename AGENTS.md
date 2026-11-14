# OhMyDSH

DSH 插件：峰谷动态（按时段换模型路由）、提示词候选（回合结束后给几条下一步）、输入历史（空草稿按 ↑ 召回自己发过的话）三合一。一个包、一页设置、每项独立开关。

代码分两个运行时：Host 半边是 `index.js` + `lib/`，浏览器半边是 `client.js`。纯 ESM，没有构建步骤。

## 文档

按当前问题选读，不需要先通读；三份文档职责不交叉，同一结论只在一处维护。

| 问题 | 去哪看 |
| --- | --- |
| 为什么做、为谁做、哪些不做、哪些理解是错的 | [docs/product.md](docs/product.md) |
| 改哪个文件、宿主 API 约定、选型理由、测试与门禁 | [docs/development.md](docs/development.md) |
| 安装卸载、DSH 版本兼容、设置迁移、发布回滚、排障 | [docs/operations.md](docs/operations.md) |
| 面向用户的安装、配置字段与行为细节 | [README.md](README.md)（英文 [README.en.md](README.en.md)） |
| 当前版本的改动 | [CHANGELOG.md](CHANGELOG.md) |

文档与代码冲突时以代码和 `package.json` 为准，并先修文档；不确定的内容写进对应文档的「待确认」，不要补成结论。

## 工作约定

- 行为改动同时检查：配置 schema 的 `volatile`、`client.js` 里与 `lib/remote.js` 同名的 remote spec、中英文案、`cordis.patch.yml` 默认值、README 与 CHANGELOG。
- 峰谷动态只能改会话模型位，不能改 `agent/request`；原因见开发文档的宿主 API 约定。
- 验证用 `npm test` 与 `npm run check`，见开发文档「验证与门禁」。
- 工作区可能带着未提交的改动：动手前先看 `git status`，只改自己负责的部分，不覆盖别人的编辑。
