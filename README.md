# Overseer

Watch and steer every subagent Claude Code starts, from a live pane beside the chat.

- **See** each subagent's model, effort, steps, tokens, live activity, the prompt its parent gave it, and its thread (the latest 160 entries).
- **Change model and effort mid-run.** The next request uses your choice.
- **Message a running subagent.** It reads your message at its next step.
- **Message a finished subagent.** It picks up again under the same id, with its history.
- **Pause and resume** a subagent before its next request.
- **Run Codex as a real subagent** you can watch live, steer mid-turn, re-tune, and continue later.
- Optional **spawn review**: approve, edit or deny each subagent's prompt before it starts.

```
● 2 running  ✓ 1 finished
Active only · Broadcast · History · Clear finished

╭──────────────────────────────────────────╮   ← an open card (blue)
│ ● demo worker                  [▲ Close] │
│ general-purpose  Running             29s │
│                                          │
│ Model [Opus 5.5 · now ▾] Effort [high · now ▾] │
│ 127k in · 875 out   5 steps              │
│                                          │
│ 2 earlier entries · open transcript      │
│   ▸ Bash: sleep 6                        │
│ You  read  12s ago                       │
│ Include the word BANANA in your reply.   │
│                                          │
│ [View transcript (6)] [■ Stop] [Pause] [Copy ID] │
│ [ Message…                     ] [Send]  │
│ ✓✓ Read by the agent · 12s ago           │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮   ← a closed card: click anywhere to open
│ ✓ docs auditor                     [▼]   │
│ Explore  Done                     1m 31s │
│ Opus 5.5 · high · 404k tokens · 7 steps  │
╰──────────────────────────────────────────╯
```

## Install

Overseer is two plugins, and you need both. `overseer` is the pane and the hooks; `overseer-courier` delivers your messages. Install them in a terminal session on every machine that runs Claude Code sessions. For the desktop app over SSH, that means the remote machine.

It needs Claude Code 2.1.280 or later. Some builds, 2.1.280 among them, keep function hooks behind a switch: add `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` to the `env` block of `~/.claude/settings.json`.

```bash
claude plugin marketplace add rohit3a/overseer
```

```bash
claude plugin install overseer@overseer
```

```bash
claude plugin install overseer-courier@overseer
```

From a local clone, use `claude plugin marketplace add /path/to/overseer` instead. Sessions then read the plugins straight from that folder, so `/reload-plugins` picks up your edits.

### Desktop app with an SSH host

Install Overseer on the SSH host. If it is also installed on your local computer, the desktop app copies your local plugins to the host for each session, without their hooks, and that copy replaces the host's own install. Overseer then never appears in those sessions.

To keep Overseer in local sessions too, load it on your computer from a clone instead of installing it, so the app does not copy it. Uninstall it there, then add this to the `env` block of `~/.claude/settings.json` on your computer:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/overseer/plugins/overseer:/path/to/overseer/plugins/overseer-courier"
```

## Use

The pane opens beside the chat when a subagent starts, unless you closed it yourself this session. While it's closed, a line above the message box shows `● 3 running · ✓ 2 finished` with an **Open Agents** button. `/overseer` toggles the pane too.

| Command | Does |
|---|---|
| `/overseer` | Open or close the Agents pane |
| `/overseer off` / `on` | Make every hook a pass-through and disable the Codex tool for this session, or turn it back on |
| `/overseer clear` | Remove finished agents from the pane (they stay in History). A Codex agent stays while its process runs; **Quit Codex** first to clear it |
| `/overseer history` | Finished agents from earlier sessions |

Every agent is a card. Click anywhere on a closed card to open it, and **▲ Close** to close it again. One card is open at a time, with a blue border. Status shows in the label: Running blue, Done green, Paused yellow, Failed red. The elapsed clock ticks by itself, without redrawing the pane.

In an open card:

- **Model / Effort.** The dropdowns show what the agent runs on now ("· now"). Pick something else and it applies from the agent's next request ("→ Sonnet 5.5 from the next request"). Pick the "now" value again to cancel. Switching effort is cheap; switching model re-reads the context without the prompt cache.
- **The latest 3 entries**, with long answers capped. **View transcript** opens the agent's thread in its own view (the latest 160 entries, long entries capped at 12,000 characters), 25 entries at a time, with **▲ Load earlier** and **◀ Back**.
- **Message box.** **Send** delivers to the agent and clears the box. A line under it tracks the message: Sending… → ✓ Delivered → ✓✓ Read by the agent (it made a request after the message arrived), or ✗ Not delivered. A finished agent wakes up with your message. Past 30 characters, a wrapped preview of everything you've typed shows under the one-line box, capped at about five lines with the end in view. Overseer also adds a note to the main conversation, so Claude knows the message really came from you.
- **■ Stop** ends a Claude subagent at its next request, or interrupts a Codex turn. **Pause / Resume** hold a Claude subagent before its next request. For Codex it reads **■ Stop turn**; Codex agents also get **Apply now** (interrupt and continue with new settings) and **Quit Codex** (ends its process; a message starts it again).
- **Broadcast** messages every running agent at once.

### Codex

Overseer gives Claude a tool, `mcp__overseer__codex`. Ask Claude to delegate to Codex and it uses that tool. A raw `codex exec` in a shell is refused, and Claude is pointed at that tool instead, so you can always see and steer the run. The check catches the usual forms (`codex exec`, a full path, `npx`, `env`, `sudo`, flags before `exec`) but not every way of hiding a command; it keeps Claude on the tool, not a determined script.

Under the hood Overseer runs `codex app-server` through a small POSIX `sh` bridge, which gives true mid-turn steering, live streaming, and per-turn model and effort. A follow-up after Codex finishes continues the same thread. Codex runs with **full access** by default (`danger-full-access`, and Codex itself asks for no approvals). Lower it in settings if you want.

Each call of the Codex tool goes through your session's permissions first, like any other tool: an allow rule or a permissive mode runs it, a deny rule refuses it, and otherwise you're asked once per call. With no one to ask (a `-p` run in a mode that would prompt), the call is refused. To let it run unattended, allow `mcp__overseer__codex` in your permission settings. Two limits: `PreToolUse` command hooks in settings files don't see Codex tool calls (rules, the mode and plugin permission hooks do), and on a build without plugin permission checks (2.1.280) the Codex tool refuses to run.

## Settings

Change these in `/config` → overseer, or with `claude plugin configure overseer@overseer`.

| Setting | Default | |
|---|---|---|
| `autoOpenPane` | on | Open the pane on the first subagent (it never takes focus) |
| `informParent` | on | Tell Claude about messages you send to subagents |
| `autoRevive` | on | If an override fails a request, drop it and tell the agent to continue |
| `redirectCodexBash` | on | Refuse raw `codex exec` in shells; point Claude at the Overseer tool |
| `codexSandbox` | `danger-full-access` | Or `workspace-write`, `read-only` |
| `codexPath` | auto | Absolute path to `codex`. Auto checks `~/.local/bin`, then `PATH`, then a login shell (finds nvm installs) |
| `spawnReview` | off | Hold each new subagent for approve / edit / deny |
| `spawnReviewTimeoutSec` | 90 | An unanswered review approves itself |
| `historyDays` | 7 | How long finished agents stay in History. The pane itself keeps the latest 50 finished agents; older ones move to History |

## How it works

Overseer uses Claude Code's function-hook plugin API (early access):

| Hook | Used for |
|---|---|
| `agent.spawn` | Records each subagent and its prompt; holds it for spawn review |
| `turn.step` | Sees every subagent request (model, effort, streaming text, tool calls) and rewrites model and effort for overrides; the pause gate |
| `turn.complete` | Records results; recovers from a failed override |
| `session.send` / `session.receive` | Tracks the parent's messages and delivery of yours |
| `ui.render` on `Pane` | The pane, one view for terminal, desktop, VS Code and mobile (mobile has buttons but no text fields or dropdowns) |
| `ui.render` on `AbovePrompt` | The one-line band that reopens the pane |

**Why two plugins:** a plugin never sees the requests of an agent its own call resumed. So Overseer queues your messages, and `overseer-courier` sends them from its own timer. That keeps Overseer able to watch and steer the agent your message woke up.

All state lives in host-held plugin state, so the pane survives `/reload-plugins` and hot reloads mid-run. Every hook fails open: if Overseer breaks, Claude carries on as if it weren't installed. `/overseer off` lets paused agents and held spawn reviews go at once. The one exception is the Codex tool: if its permission check fails, the call is refused rather than run.

Claude Code 2.1.280 has no host-held state, so there Overseer keeps its state in memory for the session, and a reload starts it over. Overseer and the courier pass messages through files in a temporary folder that only your user can enter (mode 700; a path someone else created first is refused), removed when the session ends. That build can't add a note to the conversation either, so the note about a message you sent a subagent goes in front of your next prompt. Closed cards show their summary as plain text.

## Platforms

Checked by hand with the conformance suite below (CI runs only the no-API-key checks in `scripts/check.sh`):

| Machine | Result |
|---|---|
| macOS 26 (arm64), Claude Code 2.1.299, Codex 0.162 | all checks pass |
| Ubuntu (x86_64), Claude Code 2.1.296, Codex 0.159 and 0.162 | all checks pass |
| Ubuntu (x86_64), Claude Code 2.1.280, 2.1.304 and 2.1.306 | `scripts/check.sh` passes. 2.1.280's test kit ignores a test's own settings, so the spawn review test runs only on the newer two. On 2.1.280 a live session was also checked by hand: the pane, the band and a subagent tracked to the end. The conformance suite and Codex were not run there. |

Windows is untested and expected to need WSL: pause and spawn review wait on the `sleep` command, and the Codex bridge needs `sh` and `mkfifo`.

## Develop

```bash
sh scripts/types.sh
```

```bash
sh scripts/check.sh
```

```bash
sh probes/conformance.sh
```

- `scripts/check.sh` runs validation, type-checking and the plugin tests. It needs no API key.
- `probes/conformance.sh` runs real headless sessions (Haiku, a few cents) and asserts on Overseer's debug trace. It covers model and effort overrides, pause, live and resume messaging, override recovery, Codex steering, follow-ups and apply-now. `--host <ssh-host>` runs it on another machine; `--skip-codex` skips Codex.
- `OVERSEER_DEBUG_FILE=/path.json` makes Overseer write a JSON trace of its state and events.

## License

MIT
