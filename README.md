# opencode-prewalk

> Plan-mode alternative for OpenCode — hand off the context window, not a plan document. ~50% cost, ~95% of frontier pass rate.

Implementation of the **prewalk** technique ([Can Bölük / Stencil](https://stencil.so/blog/prewalk)) as a plugin for [OpenCode](https://opencode.ai), using the **stable V1** plugin API. Structure inspired by [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk) (MIT).

The idea in one line: an agent's cost is in the **reads**, not the edits. Instead of having the frontier model write a plan that the executor must re-ground by re-reading everything, you hand over the **context window**: exploration already done, todo list initialized, one verified first edit as an in-context example. At the first edit you swap to the cheap model and prune the planning instruction.

## Installation

Three files to copy: the plugin plus the two prewalk agents (the agents carry the
baked-in system prompts and pinned models for each phase — they are an integral
part of the mechanism, not just the plugin). Clone this repo and copy from your
local checkout — per project:

```sh
git clone https://github.com/Daniel-97/opencode-prewalk.git
mkdir -p .opencode/plugin .opencode/agent
cp opencode-prewalk/.opencode/plugin/prewalk.ts .opencode/plugin/prewalk.ts
cp opencode-prewalk/.opencode/agent/prewalk-frontier.md  .opencode/agent/prewalk-frontier.md
cp opencode-prewalk/.opencode/agent/prewalk-executor.md  .opencode/agent/prewalk-executor.md
```

Or globally (all projects):

```sh
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/agent
cp opencode-prewalk/.opencode/plugin/prewalk.ts           ~/.config/opencode/plugin/prewalk.ts
cp opencode-prewalk/.opencode/agent/prewalk-frontier.md   ~/.config/opencode/agent/prewalk-frontier.md
cp opencode-prewalk/.opencode/agent/prewalk-executor.md   ~/.config/opencode/agent/prewalk-executor.md
```

Without a checkout, download them straight from the repo:

```sh
mkdir -p .opencode/plugin .opencode/agent
base=https://raw.githubusercontent.com/Daniel-97/opencode-prewalk/main
curl -fsSL "$base/.opencode/plugin/prewalk.ts"           -o .opencode/plugin/prewalk.ts
curl -fsSL "$base/.opencode/agent/prewalk-frontier.md"    -o .opencode/agent/prewalk-frontier.md
curl -fsSL "$base/.opencode/agent/prewalk-executor.md"    -o .opencode/agent/prewalk-executor.md
```

Resulting layout:

```
your-project/
└── .opencode/
    ├── agent/
    │   ├── prewalk-frontier.md
    │   └── prewalk-executor.md
    ├── plugin/
    │   └── prewalk.ts
    └── prewalk.json          ← optional, see below
```

The `/prewalk` command (alias `/pw`) is **registered programmatically by the plugin** through the V1 `config` hook at startup — it is configured to start on the `prewalk-frontier` agent (so a `/prewalk` always plans on the strong model, even if the session is currently on the executor). There is no separate command file to install. Restart OpenCode after installing.


### Pinning the phase models

Each phase runs on its own OpenCode **agent**, whose system prompt **and pinned model** are baked into the agent file — this is the single source of truth for which model each phase uses:

- `prewalk-frontier` (`.opencode/agent/prewalk-frontier.md`) — the `model:` field pins the planning model.
- `prewalk-executor` (`.opencode/agent/prewalk-executor.md`) — the `model:` field pins the executor model.

There is no longer a separate `frontier`/`executor` setting or a `--into` override; edit the `model:` line in the corresponding agent file to change a phase's model. The `/prewalk` command is wired to start on the `prewalk-frontier` agent, so planning always runs on the strong model even if the session is currently on the executor. What matters is only that the planning model is meaningfully stronger than the executor.

Optional config `.opencode/prewalk.json` (see `prewalk.json.example` in this repo):

```json
{
  "maxTodos": 12,
  "confirmations": ["", "continue", "ok", "go", "yes", "proceed", "y", "next", "done"]
}
```

- `maxTodos` — todo list cap (default 12) used for the "plan may be too large" warning when the frontier exceeds it. The cap is also stated inside the frontier agent's prompt; keep the two in sync if you change it. (The article documents that without a cap GPT-5.6 creates 60-item lists and batch-completes them.)
- `confirmations` — the exact set of user messages (case-insensitive, trimmed) treated as "confirm the plan and hand off" at the ⏸️ checkpoint. The empty string means a blank message confirms. Anything not in this set is treated as a revision request and stays on the frontier agent.

## Usage

```
/prewalk Add the settings page with tabbed sections
/prewalk Refactor the auth module --no-pause
```

| Flag | Effect |
|---|---|
| *(none)* | **Manual mode (Hermes-style)**: at the ⏸️ checkpoint you get a toast; review the plan and task #1, then send a confirmation (`continue`, `ok`, …) to hand off to the executor agent, or a revision request to stay on the frontier agent |
| `--no-pause` | **Auto-swap**: when the ⏸️ checkpoint todo is added, the plugin hands off to the `prewalk-executor` agent immediately (no waiting for confirmation) |

The todo cap and the confirmation set are configured in `prewalk.json` (`maxTodos`, `confirmations`), not via flags. The executor model is pinned in `prewalk-executor.md`, not selected by a flag.

## How it works (hook mapping)

| Mechanism from the article | Implementation |
|---|---|
| `/prewalk` slash command (+ alias `/pw`) | Registered programmatically at startup via the stable V1 `config` hook — no markdown command file; it is wired to the `prewalk-frontier` agent, so it always starts planning on the strong model |
| "Hidden" planning instruction | Baked into the **system prompt of the `prewalk-frontier` agent** (`.opencode/agent/prewalk-frontier.md`). It never enters message history |
| Pruning the instruction at swap time | Phase swap = switching the session to the `prewalk-executor` agent, whose own system prompt (`.opencode/agent/prewalk-executor.md`: strict order, one todo at a time, per-item verification, no batch-completion) replaces the frontier's. There is no runtime injection or pruning hook |
| Swap gate = todo list + first edit | When the frontier adds the ⏸️ checkpoint todo, detected via the stable `todo.updated` event (recognized by the leading `⏸️` marker in the todo content), the plugin pauses the session |
| Swap moment | Manual mode: a confirmation user message (stable `message.updated` event) swaps via `client.session.prompt` with `agent: "prewalk-executor"` and the executor's pinned model. Auto mode (`--no-pause`): the swap fires immediately when the ⏸️ todo appears |
| Revision at the checkpoint | A non-confirmation user message is left for the `prewalk-frontier` agent (the session is still on it) to revise the plan; the session stays paused until a confirmation arrives |
| Session lifecycle | `session.created` initializes per-session state, `session.deleted` clears it, so abandoned sessions don't accumulate |
| Todo list steering | OpenCode's todo tool persists across the agent switch within the same session |

Deliberate difference from the article: the swap does not happen *mid-turn* at the first edit, but at the end of the frontier turn — the frontier prompt forces the model to stop right after task #1 with the ⏸️ checkpoint todo (the hermes-prewalk approach). Reliably interrupting a turn mid-flight is not exposed by the stable API, and the checkpoint is more robust anyway.

### Small-task guardrails

Prewalk only pays off when there is real work left to hand off. Two guardrails handle tasks below that threshold:

- **Prompt-level escape**: the frontier instruction tells the model to skip the protocol entirely if the task fits in one or two small edits — it just completes the task, with no todo list and no PAUSE.
- **Plugin-level skip**: when the ⏸️ checkpoint todo is added, if 0 todos remain the run is closed ("no handoff needed"); if exactly 1 remains, the handoff is skipped and the task finishes on the current agent (no swap).

## Known limitations / things to verify on your version

1. **The two agent files are required.** The mechanism depends on the `prewalk-frontier` and `prewalk-executor` agents existing (in `.opencode/agent/` or `~/.config/opencode/agent/`). If they are missing, `/prewalk` will have no agent to run on. Quick test: run `/prewalk` on a toy task and check that the model creates the todo list and stops at the ⏸️ checkpoint.
2. **The `/prewalk` command is injected at startup via the V1 `config` hook.** If `/prewalk` doesn't show up, that hook isn't firing on your build — define the command yourself as a markdown file with `agent: prewalk-frontier` and template `$ARGUMENTS`. Changes to the agent files or `prewalk.json` are picked up on the next OpenCode restart.
3. **Confirmations are matched exactly.** At the ⏸️ checkpoint a user message is a confirmation only if, after trimming and lowercasing, it is in the `confirmations` set from `prewalk.json` (empty, `continue`, `ok`, … by default). Anything else — including "continue." with a period — is treated as a revision request and stays on the frontier agent. Add the variants you want to the `confirmations` list.
4. **Hook signatures**: if something doesn't hook up, check the logs (service `prewalk`, via `client.app.log`).
5. **In-memory state**: the state machine lives in the process; restarting OpenCode mid-prewalk loses it (the todo list in the context survives, though — you can resume manually with a continuation message). Closing/deleting the session clears its state.
6. **Model persistence after the handoff**: the swap runs the kickoff on the `prewalk-executor` agent and switches the session to it; if you later cycle the TUI agent yourself, make sure it stays on `prewalk-executor`.
7. **Suitable tasks**: contained scope, 8–12 todos, existing conventions to copy, a foundational and self-contained task #1. Don't use it for trivial fixes (pointless overhead) or sprawling tasks (those need sub-agents, not a single handoff).

## Versioning & updates

The installed version is the `VERSION` constant at the top of `prewalk.ts`; releases are tagged with [semver](https://semver.org) in git (`v0.2.0`, …). To check for updates, compare your local `VERSION` with the one in this repo. To update, re-download all three files and restart OpenCode — this is also the exact instruction to hand to your agent:

```sh
base=https://raw.githubusercontent.com/Daniel-97/opencode-prewalk/main
curl -fsSL "$base/.opencode/plugin/prewalk.ts"         -o .opencode/plugin/prewalk.ts
curl -fsSL "$base/.opencode/agent/prewalk-frontier.md"  -o .opencode/agent/prewalk-frontier.md
curl -fsSL "$base/.opencode/agent/prewalk-executor.md"  -o .opencode/agent/prewalk-executor.md
```

## Attribution

Technique: Can Bölük / Stencil, ["You only need the frontier model for one single edit"](https://stencil.so/blog/prewalk) (2026-07-13). Skill structure: [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk), MIT.
