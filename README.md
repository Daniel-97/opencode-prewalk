# opencode-prewalk

> Plan-mode alternative for OpenCode — hand off the context window, not a plan document. ~50% cost, ~95% of frontier pass rate.

Implementation of the **prewalk** technique ([Can Bölük / Stencil](https://stencil.so/blog/prewalk)) as a plugin for [OpenCode](https://opencode.ai), using the **stable V1** plugin API. Structure inspired by [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk) (MIT).

The idea in one line: an agent's cost is in the **reads**, not the edits. Instead of having the frontier model write a plan that the executor must re-ground by re-reading everything, you hand over the **context window**: exploration already done, todo list initialized, one verified first edit as an in-context example. At the first edit you swap to the cheap model and prune the planning instruction.

## Installation

Clone the repo anywhere, then copy the `plugin` and `agent` directories into your `.opencode/`:

```sh
git clone --depth 1 https://github.com/Daniel-97/opencode-prewalk.git
mkdir -p .opencode
cp -r opencode-prewalk/.opencode/plugin opencode-prewalk/.opencode/agent .opencode/
rm -rf opencode-prewalk
```

Or download the archive and extract the two directories:

```sh
mkdir -p .opencode
curl -fsSL https://github.com/Daniel-97/opencode-prewalk/archive/main.tar.gz \
  | tar xz --strip=1 \
    opencode-prewalk-main/.opencode/plugin \
    opencode-prewalk-main/.opencode/agent
```

The `/prewalk` command (alias `/pw`) is registered automatically at startup — restart OpenCode after installing.

Optional config `.opencode/prewalk.json` (see `prewalk.json.example` in this repo):

```json
{
  "maxTodos": 12,
  "confirmations": ["", "continue", "ok", "go", "yes", "proceed", "y", "next", "done"]
}
```

- `maxTodos` — todo list cap (default 12) used for the "plan may be too large" warning when the frontier exceeds it. The cap is also stated inside the frontier agent's prompt; keep the two in sync if you change it. (The article documents that without a cap GPT-5.6 creates 60-item lists and batch-completes them.)
- `confirmations` — (deprecated fallback) the set of bare user messages treated as "confirm the plan" at the ⏸️ checkpoint when the user does NOT run `/pw-go`. Prefer `/pw-go`. Defaults to a small set including the empty string (a blank message confirms). Anything not matching stays on the frontier.

## Usage

```
/prewalk Add the settings page with tabbed sections
/prewalk Refactor the auth module --no-pause
```

| Flag | Effect |
|---|---|
| *(none)* | **Manual mode (command-driven)**: at the ⏸️ checkpoint you get a toast; review the plan and task #1, then run `/pw-go` to hand off to the executor, or `/pw-revise <changes>` to update the plan on the frontier (typing a free-form "continue" still works as a deprecated fallback) |
| `--no-pause` | **Auto-swap**: when the ⏸️ checkpoint todo is added, the plugin hands off to the `prewalk-executor` agent immediately (no waiting for confirmation) |

The todo cap and the confirmation set are configured in `prewalk.json` (`maxTodos`, `confirmations`), not via flags. The executor model is pinned in `prewalk-executor.md`, not selected by a flag.

## Small-task guardrails

Prewalk only pays off when there is real work left to hand off. Two guardrails handle tasks below that threshold:

- **Prompt-level escape**: the frontier instruction tells the model to skip the protocol entirely if the task fits in one or two small edits — it just completes the task, with no todo list and no PAUSE.
- **Plugin-level skip**: when the ⏸️ checkpoint todo is added, if 0 todos remain the run is closed ("no handoff needed"); if exactly 1 remains, the handoff is skipped and the task finishes on the current agent (no swap).

## Versioning & updates

The installed version is the `VERSION` constant at the top of `prewalk.ts`; releases are tagged with [semver](https://semver.org) in git (`v0.2.0`, …). To check for updates, compare your local `VERSION` with the one in this repo. To update, re-run the [installation](#installation) commands above and restart OpenCode.

## Attribution

Technique: Can Bölük / Stencil, ["You only need the frontier model for one single edit"](https://stencil.so/blog/prewalk) (2026-07-13). Skill structure: [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk), MIT.
