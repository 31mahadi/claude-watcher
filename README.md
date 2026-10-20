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
| `/watch clear [history\|plan\|all]` | Empty the history, dismiss the plan (✕ on the plan card does the same), or both |

## Dashboard

Claude Watcher is a live view of a plan being executed: ticket → plan → Claude works through it, running tests → done. At a glance it answers: which step is Claude on, what is it doing inside that step, did the step's tests pass, and does anything need me.

- **Attention** (top, only when needed, the only red or amber card): a permission prompt or question, failing tests with the failure output and the step they belong to, a stop error, or a stall (no tool activity for 90 seconds, or a command running past twice its usual time).
- **Plan**: ticket key and title, elapsed time, and a bar `3 / 5 · ~8m left`. Done steps show ✓ and their time (more than six collapse to one line). The running step is expanded: its live command with "usually ~1:30" or "first run", files edited and calls made in this step, its test result, and its checkbox sub-steps. Pending steps follow, four at most. When the turn ends with the plan unfinished, a receipt line replaces the live command.
- **Timeline**: one swimlane chart for the main loop and every subagent, with rows for agents that are running or failed.
- **Health line**: context % with a per-turn trend, git branch and dirty files, last test result, and a link when another session needs you.

### Where the plan comes from

Highest priority first. A file-based plan survives turn end, compaction, `/clear` and resume.

| Source | Detected when | Steps | Done when |
|---|---|---|---|
| superpowers plan file | Claude reads or edits `docs/superpowers/plans/*.md` (or a file titled "… Implementation Plan") | `### Task N:` headings, with their `- [ ]` steps | its ledger `.superpowers/sdd/<plan>/progress.md` says `Task N: complete`, or every checkbox is ticked |
| Plan mode | `ExitPlanMode` after plan mode named a plan file | headings or list items | checkboxes, or a matching todo |
| Todo list | `TodoWrite` | each todo | `completed` |
| Task tool | `TaskCreated` / `TaskCompleted` | each task | `TaskCompleted` |
| Prompt | every turn | none; the first line is the title | the turn ends |

With a plan file active, todos are matched to its tasks by title; extra todos become sub-steps of the running task. The ticket key (`CAM-1234`) comes from the plan title, the branch name or the prompt.

Every tool call, edited file, test result and subagent is credited to the step running at that moment.

- **History** (pinned at the bottom): every turn of the session, newest first, as one collapsed row each — time, prompt, duration, calls, tests, files, permission waits. Press a row to expand it: steps it moved, its calls with times and ✓/✗, files edited, test result with failure output, agents. Compactions, model switches, stop errors and plan loads appear between turns. A filter cycles `all` → `turns` → `problems`, and `[clear]` empties it. The last 20 turns are kept per session and survive `/clear` and resume.

Detail views: `/watch plan` (every step with its calls, files, tests and failure output), `/watch agents`, `/watch calls`, `/watch history` (every turn expanded), `/watch sessions`, `/watch health`, `/watch config`.

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
