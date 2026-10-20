# Claude Watcher

A Claude Code mod that shows what Claude is doing in one place: the current turn, the plan, subagents, your other sessions and the session's health. It works in the terminal, the Desktop app and VS Code.

- **Spinner suffix**: `npm test · 2:14 · ~1:46 left · 3/5 tasks`
- **Dashboard pane** (`/watch`) with six tabs: Turn, Plan, Agents, Sessions, Health and Config
- **Attention band** above the prompt when Claude needs you, plus an optional toast and desktop notification
- **Visuals**: Svg bars, Gantt, sparkline and donut on Desktop and VS Code; Raster bars, swimlanes and a heat strip in the terminal; a text fallback everywhere
- **Time-left estimates** learned from your own command history: `~` with 3 or more samples, `?` with fewer, `up to` when only a timeout bounds the call

Claude Watcher only observes. Every hook passes the event on unchanged, and it never blocks or denies anything.

## Install

At the prompt of a terminal session:

```
/plugin install watcher --marketplace <owner>/claude-watcher
```

From a shell:

```
claude plugin install watcher --marketplace <owner>/claude-watcher
```

To run it from a checkout:

```
claude --plugin-dir ./claude-watcher
```

## Commands

| Command | What it does |
|---|---|
| `/watch` | Open or close the dashboard |
| `/watch turn\|plan\|agents\|sessions\|health\|config` | Open on a tab |
| `/watch config set <path> <value>` | Change a setting, for example `/watch config set barWidth 30` |
| `/watch config get <path>` | Read a setting |
| `/watch reset [history\|config\|all]` | Clear duration history and/or settings |
| `/watch export` | Copy the last turn as JSON and print it |
| `/watch mute 30m` / `/watch unmute` | Silence or restore alerts |

## Tabs

- **Turn**: phase, current tool with elapsed time and ETA, progress bar, tool count, heat strip and sparkline of recent calls, and the last N calls with durations and ✓/✗.
- **Plan**: the task checklist from Claude's task tool, with per-task timing and an ETA (remaining tasks × median task time).
- **Agents**: the main loop and each subagent or teammate, with phase, current tool and elapsed time, plus a swimlane Gantt.
- **Sessions**: every Claude Code session on this machine that runs the mod. Sessions that need you are listed first. Busy sessions with no heartbeat for 10s are greyed out. Press a row to copy its `claude --resume` command.
- **Health**: needs-you state; the last test, lint and build result (jest, vitest, pytest, cargo and go test summaries are parsed); git branch, dirty file count and files edited this turn; context % with a donut and compaction count; rate limit; the last stop failure; model, effort and cost.
- **Config**: press to toggle or cycle settings.

## Configuration

Settings merge in this order, later layers winning: built-in defaults, then `<project>/.claude/watcher.json`, then your own changes (stored in the mod's store). Unknown keys and invalid values are ignored. For every key, see `DEFAULTS` in [hooks/config.ts](hooks/config.ts).

```jsonc
// .claude/watcher.json
{
  "autoOpen": "onLongTurn",      // always | onLongTurn | never
  "longTurnSeconds": 20,
  "theme": "default",            // default | minimal | dense
  "barStyle": "blocks",          // blocks | dots | ascii
  "visuals": { "gantt": true, "sparkline": true },
  "attention": { "desktopNotify": "whenUnfocused", "notifyOnTurnEndAfterSeconds": 300 },
  "sessions": { "shareState": true, "showCwd": "basename" },
  "redactCommands": false
}
```

## Compared with other progress mods

| | Watcher | progress-board | claude-task-progress | progress-tracker | session-progress | task-progress | ccmonitor |
|---|---|---|---|---|---|---|---|
| Turn / tool progress | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Plan / tasks | ✓ | ✓ | ✓ | | | ✓ | |
| Subagent lanes | ✓ | ✓ | | | | | |
| Multi-session board | ✓ | | | | | ✓ | ✓ |
| Health (tests, git, context, errors, cost) | ✓ | | | | | | |
| Svg / Raster visuals | ✓ | | | | | | |
| Settings UI | ✓ | | | | | | |
| "Needs you" band + notification | ✓ | | | ✓ | | | |

This table is based on short descriptions of each mod, not a hands-on check. Verify it before you publish it.

## Limits

- Mods cannot read window focus, so `desktopNotify: "whenUnfocused"` behaves like `"always"`.
- Desktop notifications go through your own Claude Code notification channel. `attention.sound` is honoured only when that channel is the terminal bell.
- The running indicator is a glyph that changes on a 1-second tick. There is no `Client` animation.
- Test parsing is best effort and is labelled "parsed" in the Health tab.

## Development

```
claude plugin validate .
claude plugin test .
```

The plugin API is early access. `NOTES.md` lists the events and calls this mod uses.
