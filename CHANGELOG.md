# 变更记录

## 未发布

- 新增 `create_session`。用户可以让 agent 在 DSH 侧栏创建独立会话并发送首条任务。默认沿用当前项目，可指定其他已有项目。设置页新增「会话创建」开关。

## 0.1.0

- 合并三个插件为一个：`dsh-peak-valley-model` v0.20.0、`dsh-prompt-candidates` v0.3.1、`dsh-prompt-history` v0.1.0。
- 配置改成分段：`peakValley`、`candidates`、`history`，每段一个 `enabled` 总开关（`volatile`，写完即时生效）。
- Host 侧合并成一个 Typert Remote 服务 `ohMyDsh`，两个方法 `candidates` / `history`；浏览器侧一次 `$mount` 后注入。
- 候选条、输入历史、峰谷开关与设置页的槽位 id 统一成 `oh-my-dsh.*`。
- 输入历史新增 `limit` 配置（默认 100，1–200），原来固定 100。
- 峰谷动态的整段开关独立于按会话的 `sessions`：关掉总开关不动用户已有的会话状态。
- 设置页里的「功能开关」统一成胶囊开关（轨道 + 圆钮 + 文案），与输入框右侧的峰谷开关共用同一个控件与样式；不再是「已开启」文字按钮。
- 所有设置收进唯一一页「OhMyDSH」：三个功能各占一个板块，板块头就是开关；功能关闭时该板块折叠，重新打开即展开，导航里不再有三个插件页。
- 输入历史只召回用户亲手发送的消息：助手消息、子 Agent 的 `agent-message`、框架注入的上下文都不再进入召回列表，也不占召回条数。
