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
| `/watch turn\|plan\|agents\|calls\|sessions\|health\|config` | Open the dashboard or a detail view |
| `/watch config set <path> <value>` | Change a setting, for example `/watch config set barWidth 30` |
| `/watch config get <path>` | Read a setting |
| `/watch reset [history\|config\|all]` | Clear duration history and/or settings |
| `/watch export` | Copy the last turn as JSON and print it |
| `/watch mute 30m` / `/watch unmute` | Silence or restore alerts |

## Dashboard

The pane answers three questions at a glance: does anything need me, how far along is the job, and is it stuck.

- **Attention** (top, only when needed): a permission prompt or question, failing tests with the failure output, or a stop error. The only red or amber on the dashboard.
- **Goal**: the prompt's first line, or the running todo item, with the turn's elapsed time. When Claude keeps a todo list, a bar shows `step 3 of 5` and time left. Below it, the current call, its elapsed time and its usual duration, taken from past runs of the same command or the same kind of step (tests, build, install, lint, git, edits, reads). A call running past twice its usual time, or no activity for 90 seconds, shows an amber "⏳" line.
- **Timeline**: one swimlane chart for the main loop and every subagent, with rows under it for agents that are running or failed.
- **Status**: context %, git branch and dirty files, test state.
- **Receipt** once the turn ends: calls, steps, tests, files edited, model, context, cost. Then nothing moves.

Detail views: `/watch plan`, `/watch agents`, `/watch calls` (every tool call with durations), `/watch sessions`, `/watch health`, `/watch config`.

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
