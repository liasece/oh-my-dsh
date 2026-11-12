# 变更记录

## 0.1.0

- 合并三个插件为一个：`dsh-peak-valley-model` v0.20.0、`dsh-prompt-candidates` v0.3.1、`dsh-prompt-history` v0.1.0。
- 配置改成分段：`peakValley`、`candidates`、`history`，每段一个 `enabled` 总开关（`volatile`，写完即时生效）。
- Host 侧合并成一个 Typert Remote 服务 `ohMyDsh`，两个方法 `candidates` / `history`；浏览器侧一次 `$mount` 后注入。
- 三个设置页与候选条、输入历史、峰谷开关的槽位 id 统一成 `oh-my-dsh.*`，设置页导航图标补齐三页。
- 输入历史新增 `limit` 配置（默认 100，1–200），原来固定 100。
- 峰谷动态的整段开关独立于按会话的 `sessions`：关掉总开关不动用户已有的会话状态。
