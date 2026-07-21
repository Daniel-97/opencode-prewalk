# opencode-prewalk

Implementation of the **prewalk** technique ([Can Bölük / Stencil](https://stencil.so/blog/prewalk)) as a plugin for [OpenCode](https://opencode.ai), using the **stable V1** plugin API. Structure inspired by [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk) (MIT).

The idea in one line: an agent's cost is in the **reads**, not the edits. Instead of having the frontier model write a plan that the executor must re-ground by re-reading everything, you hand over the **context window**: exploration already done, todo list initialized, one verified first edit as an in-context example. At the first edit you swap to the cheap model and prune the planning instruction.

## Installation

One file to copy. Per project:

```sh
mkdir -p .opencode/plugin
cp plugin/prewalk.ts .opencode/plugin/prewalk.ts
```

Or globally (all projects):

```sh
mkdir -p ~/.config/opencode/plugin
cp plugin/prewalk.ts ~/.config/opencode/plugin/prewalk.ts
```

Without a checkout, download it straight from the repo:

```sh
curl -fsSL https://raw.githubusercontent.com/CHANGE-ME/opencode-prewalk/main/plugin/prewalk.ts \
  -o .opencode/plugin/prewalk.ts
```

Resulting layout:

```
your-project/
└── .opencode/
    ├── plugin/
    │   └── prewalk.ts
    └── prewalk.json          ← optional, see below
```

The `/prewalk` command (alias `/pw`) is **registered programmatically by the plugin** through the V1 `config` hook at startup — there is no separate command file to install. Restart OpenCode after installing.


### Frontier model: pinning is optional

If `"frontier"` is not set, planning runs on whatever model is active in the session. Pinning it is still recommended: after an auto-swap the session may stay on the executor model, and a second `/prewalk` would then plan on the cheap model — the exact inversion of the technique. What matters is only that the planning model is meaningfully stronger than the executor.

Optional config `.opencode/prewalk.json` (see `prewalk.json.example` in this repo):

```json
{
  "frontier": "anthropic/claude-opus-4-8",
  "executor": "openrouter/deepseek/deepseek-chat",
  "maxTodos": 12,
  "nudge": false
}
```

- `frontier` — pins the model of the `/prewalk` command for the planning turn (optional but recommended, see below)
- `executor` — default model for `--no-pause`
- `maxTodos` — todo list cap (default 12; the article documents that without a cap GPT-5.6 creates 60-item lists and batch-completes them)
- `nudge` — if `true`, when the executor stops with open todos the plugin automatically re-prompts it (max 2 times)

## Usage

```
/prewalk Add the settings page with tabbed sections
/prewalk Fix the hero layout on desktop --into openrouter/qwen/qwen3-coder
/prewalk Refactor the auth module --no-pause
```

| Flag | Effect |
|---|---|
| *(none)* | **Manual mode (Hermes-style)**: at the ⏸️ PAUSE checkpoint you get a toast; review the plan and task #1, switch model (`/models`), send `continue` |
| `--into provider/model` | **Auto-swap (article-style)**: at the end of the frontier turn the plugin sends the continuation prompt on its own, with a model override |
| `--no-pause` | Auto-swap into the default executor from `prewalk.json` |

Todo cap and executor nudging are configured in `prewalk.json` (`maxTodos`, `nudge`), not via flags.

## How it works (hook mapping)

| Mechanism from the article | Implementation |
|---|---|
| `/prewalk` slash command (+ alias `/pw`) | Registered programmatically at startup via the V1 `config` hook — no markdown command file; the `frontier` pin from `prewalk.json` becomes the command's `model` |
| "Hidden" planning instruction | Injected into the **system prompt** via `experimental.chat.system.transform`, only during the `frontier` phase. It never enters message history |
| Pruning the instruction at swap time | Automatic: when the phase becomes `executor`, the frontier injection stops and is replaced by an executor-discipline instruction (strict order, one todo at a time, per-item verification, no batch-completion) |
| Swap gate = todo list + first edit | `tool.execute.before` tracks `todowrite` (items, PAUSE, remaining); `tool.execute.after` detects the first successful `edit`/`write` |
| Swap moment | `session.idle` event at the end of the frontier turn: checkpoint toast (manual) or `client.session.prompt` with `body.model` override (auto) |
| Todo list steering | OpenCode's todo tool persists across the model switch within the same session |

Deliberate difference from the article: the swap does not happen *mid-turn* at the first edit, but at end of turn — the frontier prompt forces the model to stop right after task #1 with the ⏸️ PAUSE todo (the hermes-prewalk approach). Reliably interrupting a turn mid-flight is not exposed by the V1 API, and the checkpoint is more robust anyway.

### Small-task guardrails

Prewalk only pays off when there is real work left to hand off. Two guardrails handle tasks below that threshold:

- **Prompt-level escape**: the frontier instruction tells the model to skip the protocol entirely if the task fits in one or two small edits — it just completes the task, with no todo list and no PAUSE.
- **Plugin-level skip**: at the end of the frontier turn, if 0 todos remain the run is closed ("no handoff needed"); if exactly 1 remains, the handoff is skipped and the task finishes on the current model (in auto mode the plugin sends the continue prompt itself, without a model override).

## Known limitations / things to verify on your version

1. **Pruning depends on `experimental.chat.system.transform`, which is, well, experimental.** If it doesn't fire on your build, the frontier never receives the planning instruction. Quick test: run `/prewalk` on a toy task and check that the model creates the todo list and stops at PAUSE. Fallback: create `.opencode/command/prewalk.md` manually with the planning instruction inline in the template (losing the pruning — the same trade-off hermes-prewalk made).
2. **The `/prewalk` command is injected at startup via the V1 `config` hook.** If `/prewalk` doesn't show up, that hook isn't firing on your build — same fallback as above: define the command yourself as a markdown file with template `[prewalk] $ARGUMENTS`. Also note that changes to `prewalk.json` (e.g. the `frontier` pin) are picked up on the next OpenCode restart.
3. **Hook signatures**: the code reads `sessionID` defensively from multiple locations; if something doesn't hook up, check the logs (service `prewalk`, via `client.app.log`).
4. **In-memory state**: the state machine lives in the process; restarting OpenCode mid-prewalk loses it (the todo list in the context survives, though — you can resume manually with a continuation message).
5. **Model persistence after auto-swap**: the model override is passed on every prompt the plugin sends, but if you send a message yourself after the handoff, make sure the TUI is on the executor model.
6. **Suitable tasks**: contained scope, 8–12 todos, existing conventions to copy, a foundational and self-contained task #1. Don't use it for trivial fixes (pointless overhead) or sprawling tasks (those need sub-agents, not a single handoff).

## Attribution

Technique: Can Bölük / Stencil, ["You only need the frontier model for one single edit"](https://stencil.so/blog/prewalk) (2026-07-13). Skill structure: [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk), MIT.
