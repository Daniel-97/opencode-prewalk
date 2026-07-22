# opencode-prewalk

> Plan-mode alternative for OpenCode — hand off the context window, not a plan document. ~50% cost, ~95% of frontier pass rate.

Implementation of the **prewalk** technique ([Can Bölük / Stencil](https://stencil.so/blog/prewalk)) as a plugin for [OpenCode](https://opencode.ai), using the **stable V1** plugin API. Structure inspired by [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk) (MIT).

The idea in one line: an agent's cost is in the **reads**, not the edits. Instead of having the frontier model write a plan that the executor must re-ground by re-reading everything, you hand over the **context window**: exploration already done, todo list initialized, one verified first edit as an in-context example. At the first edit you swap to the cheap model and prune the planning instruction.

## Installation

1. Clone the repo anywhere, then copy the `plugin` and `agent` directories into your `.opencode/`:

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

2. **Pin a cheaper executor model** (required for the cost savings). Either set `model:` in `.opencode/agent/prewalk-executor.md`, or add `"executor": "openrouter/deepseek/deepseek-chat"` to `.opencode/prewalk.json`. Without one, prewalk still hands off but the executor runs on the frontier model — the ~50% cost saving does not apply.

3. Restart OpenCode — the `/prewalk` command (alias `/pw`) is registered automatically at startup.

Optional config `.opencode/prewalk.json` (see `prewalk.json.example` in this repo):

```json
{
  "maxTodos": 12,
  "confirmations": ["", "continue", "ok", "go", "yes", "proceed", "y", "next", "done"]
}
```

- `executor` — (optional) `"provider/model-id"` pin for the executor, with precedence over any pin in `prewalk-executor.md`. The split is on the FIRST `/`, so multi-segment IDs like `"openrouter/deepseek/deepseek-chat"` work. Without this OR a pin in `prewalk-executor.md` the handoff warns and runs on the session's model — no cost savings.
- `maxTodos` — threshold (default 12) for the "plan may be too large" warning when the frontier exceeds it. It governs only the warning — the actual list cap lives in the frontier agent's prompt. They are kept aligned by convention; changing one does not change the other.
- `confirmations` — (deprecated fallback) the set of bare user messages treated as "confirm the plan" at the ⏸️ checkpoint when the user does NOT run `/pw-go`. Prefer `/pw-go`. Defaults to a small set not including the empty string (a blank message does NOT confirm — add `""` to the array if you need that). Anything not matching stays on the frontier.

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

## Differences from the article

- **Checkpoint at end of turn, not mid-edit.** The article swaps at the first edit, mid-frontier-turn. OpenCode's V1 API does not expose a reliable mid-turn interrupt, so prewalk swaps at the ⏸️ checkpoint, after the frontier's summary turn completes (deferred to `session.idle`).
- **Explicit agent handoff, not seamless continuation.** The article prefills subsequent turns so the cheap model never notices a handoff. prewalk swaps the agent explicitly via `/pw-go` (or auto-swap in `--no-pause`) and an explicit kickoff message; the executor prompt avoids protocol meta-language to match the seamless-continuation idea as closely as the API allows.

## Small-task guardrails

Prewalk only pays off when there is real work left to hand off. Two guardrails handle tasks below that threshold:

- **Prompt-level escape**: the frontier instruction tells the model to skip the protocol entirely if the task fits in one or two small edits — it just completes the task, with no todo list and no PAUSE.
- **Plugin-level skip**: when the ⏸️ checkpoint todo is added, if 0 todos remain the run is closed ("no handoff needed"); if exactly 1 remains, the handoff is skipped and the task finishes on the current agent (no swap).

## Versioning & updates

The installed version is the `VERSION` constant at the top of `prewalk.ts`. To check for updates, compare your local `VERSION` with the one in this repo. To update, re-run the [installation](#installation) commands above and restart OpenCode.

## Limitations

- **In-memory state:** prewalk's phase machine lives in the plugin process. A restart of OpenCode mid-prewalk loses it; resume manually by sending a continuation message (`/pw-go` or any prompt to the executor). The todo list and conversation context survive in the session.
- **Checkpoint format:** the handoff gates on a todo whose content starts with `⏸️ PAUSE`, `PAUSE`, or `[PAUSE]` (uppercase). If the frontier emits it differently the protocol silently does not engage — the plugin warns on `session.idle` when a todo list exists without a detected checkpoint.
- **Model pin required for savings:** without a pinned executor model (agent file or `prewalk.json` `executor` key) the handoff changes agent but not model — the cost savings do not apply.

## Attribution

Technique: Can Bölük / Stencil, ["You only need the frontier model for one single edit"](https://stencil.so/blog/prewalk) (2026-07-13). Skill structure: [westfable/hermes-prewalk](https://github.com/westfable/hermes-prewalk), MIT.
