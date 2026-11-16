# OhMyDSH

OhMyDSH brings four features to DSH.

- **Peak/valley routing** — swap the session's model seat to a per-window route inside configured hours, and to an off-peak route outside them.
- **Prompt candidates** — after a turn ends, ask the current model for a few one-click next prompts.
- **Input history** — with an empty draft, press ↑ to walk back through the messages you already sent, ↓ to walk forward.
- **Session creation** — ask your agent to start a separate conversation with a task. Open it from the sidebar to continue.

All settings live on one OhMyDSH page, with a switch for each feature.

| Feature | What it does | Where | Switch |
| --- | --- | --- | --- |
| Peak/valley | Swaps the model seat per time window | Chip on the right of the composer; Settings → OhMyDSH → Peak/valley | Chip (per session) + the section's capsule switch |
| Prompt candidates | Suggests next prompts after a turn | Bar above the composer; Settings → OhMyDSH → Prompt candidates | The section's capsule switch |
| Input history | ↑ / ↓ recall sent messages; Esc dismisses, Enter sends | Keyboard only; Settings → OhMyDSH → Input history | The section's capsule switch |
| Session creation | Starts a user-visible conversation with an initial task | The `create_session` agent tool and the DSH sidebar | Settings → OhMyDSH → Session creation |

## Install

Install the bundle into the current profile from a DSH session:

```json
{ "action": "install_bundle", "target": "/path/to/oh-my-dsh" }
```

Replace `target` with the absolute path of your checkout. The package is plain ESM; there is no build step.

A newly installed bundle is loaded on the next DSH start; the running app cannot hot-load a new bundle row. Config and feature switches never need a restart.

## Configuration

Each feature has a section in the profile's `cordis.patch.yml`. Fields exposed in Settings are `volatile` and apply immediately.

```yaml
- id: oh-my-dsh
  name: oh-my-dsh
  config:
    peakValley:
      enabled: true
      timeZone: Asia/Shanghai
      peakWindows:
        - { start: '09:00', end: '12:00', provider: deepseek-account, model: deepseek-flash }
      offPeakRoute: { provider: deepseek-account, model: deepseek-flash }
      sessions: { <session-id>: true }
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

| Section | Fields |
| --- | --- |
| `peakValley` | `enabled`, `timeZone`, `peakWindows[]`, `offPeakRoute`, `sessions`, `lastToggle` |
| `candidates` | `enabled`, `maxSuggestions` (1–5), `historyMessages` (1–40), `maxOutputTokens`, `timeoutMs`, `provider`, `model`, `debug` |
| `history` | `enabled`, `limit` (1–200, default 100) |
| `sessionCreation` | `enabled` (default `true`) |

## Starting a separate conversation

Ask “Open a new conversation called Documentation review and have it check the README installation steps.” The new conversation starts in the current project with its own history. Its first message identifies the sending agent. You can continue either conversation independently.

In a grouped sidebar, look under the destination workspace. **Last updated** shows pinned conversations first and orders ordinary conversations by creation time or the most recent user prompt. The workspaces keep their saved order. To see recent conversations across projects, choose **In one list** and **Last updated** in the sidebar view options. In **Manual** order, background creations follow the conversations you have already arranged.

The `create_session` tool takes a required `prompt` and an optional `title` and `workspace`. The title defaults to the opening words of the prompt. The conversation inherits the current directory, model, agent preset and permissions. When the user names another registered project, the tool accepts its exact name, path or ID and starts at that project's root. Moving write access outside the current sandbox requires DSH approval.

Creation requires an ordinary conversation and a turn initiated by its user. Subagents, plan mode and guest turns cannot start a conversation. The result includes the title, `sessionId` and whether the initial task was submitted (`started`). Turning the feature off stops new creations.

## Migrating from the three plugins

Every field maps one-to-one; it just moves under a section key. Replace the `peak-valley-model` row with `oh-my-dsh`, move its `config` under `peakValley:`, move the candidates config under `candidates:` and the history config under `history:`, then drop the three old packages from `dsh.profile.bundles` and the profile's `dependencies`. Restart DSH.

Keep `lastToggle`: it records whether the last manual action was "on" or "off" and decides what a new session inherits.

## Behavior notes

- **Peak/valley** ships with both windows pointing at the same route as off-peak, so a fresh install switches nothing until you edit the two windows into your second route. It is per session and off by default; `lastToggle` only seeds newly created sessions. Routes are applied by rewriting the session's model seat (`sessionController.selectModel`), never by intercepting requests. A manual model change turns the session off (and records `lastToggle`). Alignment runs on mount, every 15s, at turn end and on switch change — never mid-turn. Subagent sessions are skipped.
- **Candidates** only generate when the session sits on a finished turn, deduped by log length; Tab is consumed inside the composer card only, and nothing is written to the session log.
- **Input history** only takes over ↑/↓ when the draft is empty (or the caret is on the first/last line of a multi-line draft). It replays the wire text of messages you sent yourself; assistant messages, sub-agent `agent-message`s and framework-injected context never enter the list and do not use up its limit. `@[label](dsh-file:…)` references come back as text, images and attachments are not recalled. Reading the session log makes no model call, so recall costs no model quota; prompt candidates do make one call per finished turn and can be switched off.

## Development

```bash
npm install
npm test
```

`client.js` is the merged browser half; `index.js` plus `lib/` is the host half. Tests cover pure routing helpers, the host alignment logic with fakes, and the real client components under jsdom.

## License

MIT.
