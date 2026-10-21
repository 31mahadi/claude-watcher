# Claude Watcher

A Claude Code mod that shows what Claude is doing in one place: the current turn, the plan, subagents, your other sessions and the session's health. It works in the terminal, the Desktop app and VS Code.

- **Spinner suffix**: `npm test · 2:14 · ~1:46 left · 3/5 tasks`
- **Dashboard pane** (`/watch`) with six tabs: Turn, Plan, Agents, Sessions, Health and Config
- **Attention band** above the prompt when Claude needs you, plus an optional toast and desktop notification
- **Visuals**: Svg bars, Gantt, sparkline and donut on Desktop and VS Code; Raster bars, swimlanes and a heat strip in the terminal; a text fallback everywhere
- **Time-left estimates** learned from your own command history: `~` with 3 or more samples, `?` with fewer, `up to` when only a timeout bounds the call

Claude Watcher only observes. Every hook passes the event on unchanged, and it never blocks or denies anything.

## Install

Requires Claude Code 2.1.304 or later.

At the prompt of a terminal session:

```
/plugin install watcher --marketplace 31mahadi/claude-watcher
```

From a shell:

```
claude plugin install watcher --marketplace 31mahadi/claude-watcher
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
| `/watch checks` / `/watch changes` | Every check run with failure output / the full change ledger |
| `/watch clear [history\|plan\|checks\|all]` | Empty the history, dismiss the plan, empty the checks, or all three |

## Dashboard

One pane you can leave open all day. It answers, at a glance: does anything need me, which step of the plan is Claude on, what has it changed, did its checks pass, and how long until context compaction.

```
╭ USAGE ──────────────────────────────────────────────╮
│ session  ━━━━━──────────  24%  resets in 2h 5m      │
│ weekly   ━━━━━━━━───────  41%  resets Sat           │
╰─────────────────────────────────────────────────────╯
╭ STATUS ─────────────────────────────────────────────╮
│ ● Running  Bash npm test · 0:41                     │
│   ↳ Explore  Read src/login.ts · 0:07               │
╰─────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────╮
│ PLAN  CAM-77 · Migrate auth      step 3 of 7 · ~8m  │
│       ▰▰▰▱▱▱▱                               2 done  │
│       ✓ Read existing auth code                1m   │
│       ✓ Write the failing test                 2m   │
│       ▶ Rewrite login handler                       │
│       ○ Update docs                                 │
│ NOW   main     ━━━━━━━━━━━━━                        │
│       Explore      ━━━━━                            │
│       tests ✗   files changed +42 −7   context 57%  │
╰─────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────╮
│ HISTORY  ▾ hide  ▂▅▃█  [▸ open a past turn… ▾]  ✕ clear  │
│ ✓ Turn 2  fix failing test   20:30 → 20:32 · 2m 11s │
╰─────────────────────────────────────────────────────╯
view ▾   history ▾   actions… ▾
```

- **Usage** (always on top): every usage window the session reports, as `/usage` shows them: session (5-hour), weekly, and per-model weekly windows. Each has a bar, the percent and when it resets. Amber from 70%, red from 90%.
- **Status**: what Claude is doing right now (Thinking, Running with the current command and its timer, Needs you, Idle), then one line per running subagent with what it is doing.
- **Attention** (only when needed): a permission prompt or question, failing tests with the failure output and their step, a stop error, or a stall.
- **Plan**: ticket and title, progress and time left, then every step in order: done ✓, running ▶ with its live command, waiting ○. Only plans of more than 20 steps fold their done steps.
- **Now**: one timeline for the main loop and every subagent, frozen once the turn ends; a live tree of the current turn; chips for tests, changed files and context.
- **Changes**: every file Claude edited this session with `+N −M`, from `git diff --numstat` against the commit the session started from; your own edits counted separately.
- **Checks**: each test, lint and build command with its last five outcomes (`✗ ✗ ✓`), kept across `/clear` and resume.
- **Context**: usage with a gauge and a forecast of turns left before compaction (`health.compactAtPct`, default 85).
- **Idle**: when nothing runs, the status reads `Idle` and Now shows `Idle · last turn 2:11 · 16 calls · tests ✓ · 2 files`.
- **Footer**: `view` switches between the dashboard and detail views, `history` filters history (all, turns, problems), `actions…` opens the plan file, the failing test at its line, or a changed file in VS Code (`code -g`; the path is copied when `code` isn't available), or copies the resume command; it also has `clear plan` and `clear history`.
- **Badge**: the pane's tab reads `Watcher · 1` while something needs you.
- **Any width**: the pane fits the terminal, the Desktop app and the VS Code side panel. Charts size to the pane; narrow panes drop secondary columns, and very narrow ones go compact.

When every step of a plan is done it shows `✓ all N steps done`, history records `plan finished`, and the plan clears itself when the next turn starts.

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

- **History** (pinned at the bottom): every turn of the session, newest first, as a card: time `start → end`, prompt, duration, steps moved, calls, tests, files and agents. The latest 3 turns show; `↓ load 3 more` adds older ones and `↑ show less` goes back. `▾ hide` / `▸ show N turns` collapses it, `✕ clear` empties it, and `▸ open a past turn…` replays a past turn as the dashboard looked when it ended, with a `← dashboard` button to return. Compactions, model switches, stop errors and plan loads appear between turns. The last 20 turns are kept per session and survive `/clear` and resume.

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

## Limits

- Mods cannot read window focus, so `desktopNotify: "whenUnfocused"` behaves like `"always"`.
- Desktop notifications go through your own Claude Code notification channel. `attention.sound` is honoured only when that channel is the terminal bell.
- The running indicator pulses on the terminal and the Desktop app; VS Code shows a still dot.
- Test parsing is best effort and is labelled "parsed" in the Health tab.

## Development

Run from a checkout with Claude Code 2.1.304 or later:

```
claude plugin validate .
claude plugin test .
```

## License

MIT. See [LICENSE](LICENSE).
