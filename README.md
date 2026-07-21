# opencode-prewalk

> Plan-mode alternative for OpenCode — hand off the context window, not a plan document. ~50% cost, ~95% of frontier pass rate.

Implementation of the **prewalk** technique ([Can Bölük / Stencil](https://stencil.so/blog/prewalk)) as a plugin for [OpenCode](https://opencode.ai), using the **stable V1** plugin API. Structure inspired by [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk) (MIT).

The idea in one line: an agent's cost is in the **reads**, not the edits. Instead of having the frontier model write a plan that the executor must re-ground by re-reading everything, you hand over the **context window**: exploration already done, todo list initialized, one verified first edit as an in-context example. At the first edit you swap to the cheap model and prune the planning instruction.

## Installation

Copy the three files to your project and restart OpenCode.

```sh
repo=https://github.com/Daniel-97/opencode-prewalk.git
git clone "$repo" /tmp/opencode-prewalk
mkdir -p .opencode/plugin .opencode/agent
cp /tmp/opencode-prewalk/.opencode/plugin/prewalk.ts           .opencode/plugin/
cp /tmp/opencode-prewalk/.opencode/agent/prewalk-frontier.md   .opencode/agent/
cp /tmp/opencode-prewalk/.opencode/agent/prewalk-executor.md   .opencode/agent/
rm -rf /tmp/opencode-prewalk
```

Or download directly without cloning:

```sh
mkdir -p .opencode/plugin .opencode/agent
base=https://raw.githubusercontent.com/Daniel-97/opencode-prewalk/main
curl -fsSL "$base/.opencode/plugin/prewalk.ts"         -o .opencode/plugin/prewalk.ts
curl -fsSL "$base/.opencode/agent/prewalk-frontier.md"  -o .opencode/agent/prewalk-frontier.md
curl -fsSL "$base/.opencode/agent/prewalk-executor.md"  -o .opencode/agent/prewalk-executor.md
```

The `/prewalk` command (alias `/pw`) is registered automatically by the plugin at startup — no command file needed. Restart OpenCode after installing.

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

## Small-task guardrails

Prewalk only pays off when there is real work left to hand off. Two guardrails handle tasks below that threshold:

- **Prompt-level escape**: the frontier instruction tells the model to skip the protocol entirely if the task fits in one or two small edits — it just completes the task, with no todo list and no PAUSE.
- **Plugin-level skip**: when the ⏸️ checkpoint todo is added, if 0 todos remain the run is closed ("no handoff needed"); if exactly 1 remains, the handoff is skipped and the task finishes on the current agent (no swap).

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
