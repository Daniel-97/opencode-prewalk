/**
 * opencode-prewalk — Prewalk technique for OpenCode (V1 stable plugin API)
 *
 * Technique by Can Bölük / Stencil: https://stencil.so/blog/prewalk
 * Skill/prompt structure inspired by westfable/hermes-prewalk (MIT).
 *
 * Flow:
 *   /prewalk <task> [--into provider/model] [--no-pause]
 *
 *   Phase "frontier":  planning instruction is injected into the SYSTEM prompt
 *                      (never into message history). The frontier model explores,
 *                      creates a todo list, completes task #1, adds a PAUSE todo.
 *   Swap gate:         todo list created AND first edit landed (or PAUSE todo seen).
 *   On session.idle:   - manual mode  -> toast checkpoint, wait for user "continue"
 *                      - auto mode    -> plugin sends the executor kickoff prompt
 *                                        with a model override (client.session.prompt)
 *   Phase "executor":  the planning instruction is no longer injected (= the
 *                      "prune the planning instruction" step of the article);
 *                      a small executor-discipline instruction replaces it.
 *
 * NOTE: hook signatures are written defensively because minor fields differ
 * between OpenCode releases. Check the log ("prewalk" service) if in doubt.
 */

import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------

type Phase = "frontier" | "paused" | "executor"

interface ModelRef {
  providerID: string
  modelID: string
}

interface PrewalkState {
  phase: Phase
  todoCreated: boolean
  firstEditLanded: boolean
  edits: number
  pauseSeen: boolean
  maxTodos: number
  executor?: ModelRef // set => auto-swap mode
  nudgeEnabled: boolean
  nudges: number
  todosRemaining: number
  warnedNoProgress: boolean
}

interface PrewalkDefaults {
  executor?: string // "provider/model" — default executor for --no-pause
  frontier?: string // "provider/model" — pins the model of the /prewalk command
  maxTodos: number
  nudge: boolean
}

const VERSION = "0.1.0"

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])
const MARKER = "[prewalk]"

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const frontierInstruction = (maxTodos: number) => `
<prewalk phase="frontier">
You are running the PREWALK protocol, phase 1 (frontier planner). Follow it exactly.

0. TRIVIALITY CHECK first: if the task clearly fits in one or two small edits,
   skip this protocol entirely — complete the task directly, verify it, and
   stop. No todo list, no PAUSE item.
1. EXPLORE the codebase deeply first: config files, entry points, every file
   relevant to the task; grep for existing patterns and conventions. Everything
   you read now is inherited by the rest of the run — read what matters, once.
2. Do NOT use web search or fetch external resources during this phase.
3. When the approach is clear, create a todo list with the todo tool:
   at most ${maxTodos} items. Each item must be a complete task:
   concrete file path + what to do + a verification criterion ("verify: ...").
   Item #1 must be the foundational task everything else builds on.
4. Complete task #1 — and ONLY task #1. Make its edit(s), run its verification,
   and mark it completed only after the verification passes. Do not start #2.
5. Add a final todo item "⏸️ PAUSE — handoff checkpoint" as in_progress, then
   STOP: end your turn with a 3–5 line summary of the plan and what task #1 proved.

Budget: this phase should stay compact (~7–10 exploration steps). If you cannot
converge on a plan, say so and stop instead of thrashing.
</prewalk>`

const executorInstruction = `
<prewalk phase="executor">
You are continuing the PREWALK protocol, phase 3 (executor). The exploration,
the plan (todo list) and one completed, verified task (#1) are already in this
conversation — trust them, do not redo them.

1. Check off the "⏸️ PAUSE" todo, then work the remaining todos STRICTLY IN
   ORDER, exactly one at a time. Never batch-complete items.
2. Mark an item in_progress before working it; run its verification criterion
   and mark it completed only after the verification passes.
3. Imitate the pattern, style and verification cadence demonstrated by task #1.
4. Do not re-read files already read in this conversation unless an edit
   requires fresh context. Do not use web search.
5. Before declaring completion, re-read the todo list: done means zero
   unchecked items. Explicitly report any item you could not complete.
</prewalk>`

const executorKickoff =
  "Continue from the checkpoint: check off the PAUSE todo and proceed with the " +
  "remaining todos in order, one at a time, verifying each before moving on."

const nudgeMessage =
  "The todo list still has unchecked items. Continue with the next todo, " +
  "one at a time, verifying each. Do not declare completion with open items."

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseModel(spec: string): ModelRef | undefined {
  const idx = spec.indexOf("/")
  if (idx <= 0 || idx === spec.length - 1) return undefined
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) }
}

function isPauseTodo(t: any): boolean {
  const s = `${t?.content ?? ""}`
  return s.includes("PAUSE") || s.includes("⏸")
}

function loadDefaults(directory: string): PrewalkDefaults {
  const out: PrewalkDefaults = { maxTodos: 12, nudge: false }
  try {
    const p = path.join(directory, ".opencode", "prewalk.json")
    const raw = JSON.parse(fs.readFileSync(p, "utf8"))
    if (typeof raw.executor === "string") out.executor = raw.executor
    if (typeof raw.frontier === "string") out.frontier = raw.frontier
    if (Number.isInteger(raw.maxTodos)) out.maxTodos = raw.maxTodos
    if (typeof raw.nudge === "boolean") out.nudge = raw.nudge
  } catch {
    /* no config file — use defaults */
  }
  return out
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const PrewalkPlugin: Plugin = async ({ client, directory }) => {
  const states = new Map<string, PrewalkState>()
  const defaults = loadDefaults(directory ?? process.cwd())

  const log = (level: "info" | "warn", message: string, extra?: Record<string, unknown>) =>
    client.app
      .log({ body: { service: "prewalk", level, message, extra } })
      .catch(() => {})

  const toast = (message: string, variant: "info" | "success" | "warning" = "info") =>
    client.tui?.showToast?.({ body: { message, variant } }).catch?.(() => {})

  /** If a hook doesn't expose sessionID and exactly one prewalk is active, use it. */
  const soleSession = (): string | undefined =>
    states.size === 1 ? [...states.keys()][0] : undefined

  const modelLabel = (m?: ModelRef) => (m ? `${m.providerID}/${m.modelID}` : "?")

  await log("info", "prewalk plugin loaded", { version: VERSION, defaults: defaults as any })

  return {
    // -----------------------------------------------------------------------
    // 0) Register the /prewalk command programmatically (no markdown file).
    //    OpenCode calls this hook while assembling its config at startup;
    //    the injected definition is equivalent to a .opencode/command/*.md file.
    //    Set "frontier" in prewalk.json to pin the planning model.
    // -----------------------------------------------------------------------
    config: async (config: any) => {
      if (!config || typeof config !== "object") return
      config.command = config.command ?? {}
      const definition = {
        description:
          "Prewalk — frontier explores, plans, lands the first edit; then hands off to the executor",
        template: `${MARKER} $ARGUMENTS`,
        ...(defaults.frontier ? { model: defaults.frontier } : {}),
      }
      // Don't clobber commands the user defined with the same names.
      config.command.prewalk = config.command.prewalk ?? definition
      config.command.pw = config.command.pw ?? definition
    },

    // -----------------------------------------------------------------------
    // 1) Detect /prewalk trigger + parse flags; flip paused -> executor.
    // -----------------------------------------------------------------------
    "chat.message": async (_input: any, output: any) => {
      const sessionID: string | undefined =
        output?.message?.sessionID ?? _input?.sessionID ?? soleSession()
      if (!sessionID) return

      const parts: any[] = output?.parts ?? []
      const textPart = parts.find((p) => p?.type === "text" && typeof p.text === "string")
      const text: string = textPart?.text ?? ""

      // Resume after manual checkpoint: any user message un-pauses.
      const existing = states.get(sessionID)
      if (existing?.phase === "paused" && !text.trimStart().startsWith(MARKER)) {
        existing.phase = "executor"
        await log("info", "prewalk: paused -> executor (manual continue)", { sessionID })
        return
      }

      if (!text.trimStart().startsWith(MARKER)) return

      // --- parse flags -----------------------------------------------------
      const intoMatch = text.match(/--into\s+(\S+)/)
      const noPause = /--no-pause\b/.test(text)

      let executor: ModelRef | undefined
      if (intoMatch) executor = parseModel(intoMatch[1])
      else if (noPause && defaults.executor) executor = parseModel(defaults.executor)

      if ((intoMatch || noPause) && !executor) {
        toast(
          "prewalk: invalid/missing executor model — falling back to manual mode (checkpoint)",
          "warning",
        )
      }

      states.set(sessionID, {
        phase: "frontier",
        todoCreated: false,
        firstEditLanded: false,
        edits: 0,
        pauseSeen: false,
        maxTodos: defaults.maxTodos,
        executor,
        nudgeEnabled: defaults.nudge,
        nudges: 0,
        todosRemaining: 0,
        warnedNoProgress: false,
      })

      // Strip marker + flags from the visible message, keep only the task.
      if (textPart) {
        textPart.text = text
          .replace(MARKER, "")
          .replace(/--into\s+\S+/g, "")
          .replace(/--no-pause\b/g, "")
          .trim()
        if (!textPart.text) textPart.text = "Proceed with the task."
      }

      await log("info", "prewalk: frontier phase started", {
        sessionID,
        executor: modelLabel(executor),
        auto: !!executor,
      })
      toast(
        executor
          ? `prewalk started — auto-swap into ${modelLabel(executor)}`
          : "prewalk started — manual checkpoint at PAUSE",
      )
    },

    // -----------------------------------------------------------------------
    // 2) Phase-dependent system-prompt injection (the "pruning" mechanism):
    //    frontier -> planning instruction; executor -> discipline instruction.
    //    The instruction never enters message history.
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (input: any, output: any) => {
      const sessionID: string | undefined =
        input?.sessionID ?? input?.message?.sessionID ?? soleSession()
      const st = sessionID ? states.get(sessionID) : undefined
      if (!st || !Array.isArray(output?.system)) return
      if (st.phase === "frontier") output.system.push(frontierInstruction(st.maxTodos))
      else if (st.phase === "executor") output.system.push(executorInstruction)
    },

    // -----------------------------------------------------------------------
    // 3) Track todo list state (count, PAUSE item) from todowrite args.
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      const st = states.get(input?.sessionID)
      if (!st) return
      if (input?.tool !== "todowrite") return

      const todos: any[] = output?.args?.todos ?? []
      if (!Array.isArray(todos) || todos.length === 0) return

      st.todoCreated = true
      if (todos.some(isPauseTodo)) st.pauseSeen = true
      st.todosRemaining = todos.filter(
        (t) => t?.status !== "completed" && !isPauseTodo(t),
      ).length

      const real = todos.filter((t) => !isPauseTodo(t)).length
      if (st.phase === "frontier" && real > st.maxTodos) {
        toast(`prewalk: ${real} todos > cap ${st.maxTodos} — plan may be too large`, "warning")
      }
    },

    // -----------------------------------------------------------------------
    // 4) Arm the swap when the first edit lands after the todo list exists.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, _output: any) => {
      const st = states.get(input?.sessionID)
      if (!st || st.phase !== "frontier") return
      if (!EDIT_TOOLS.has(input?.tool)) return
      st.edits++
      if (st.todoCreated && !st.firstEditLanded) {
        st.firstEditLanded = true
        await log("info", "prewalk: first edit landed — swap armed", {
          sessionID: input.sessionID,
        })
      }
    },

    // -----------------------------------------------------------------------
    // 5) Act at end of turn (session.idle): checkpoint or auto-swap;
    //    optionally nudge the executor while todos remain.
    // -----------------------------------------------------------------------
    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return
      const sessionID: string | undefined = event?.properties?.sessionID
      const st = sessionID ? states.get(sessionID) : undefined
      if (!st || !sessionID) return

      if (st.phase === "frontier") {
        const ready = (st.todoCreated && st.firstEditLanded) || st.pauseSeen
        if (!ready) {
          if (st.edits > 0) {
            // Triviality bail-out: the model completed the task directly
            // (prompt rule 0) — nothing to hand off.
            toast("prewalk: task completed directly in the frontier phase — no handoff needed", "success")
            await log("info", "prewalk: triviality bail-out", { sessionID, edits: st.edits })
            states.delete(sessionID)
          } else if (!st.warnedNoProgress) {
            st.warnedNoProgress = true
            toast(
              "prewalk: frontier turn ended without todo+edit — task may not suit prewalk",
              "warning",
            )
          }
          return
        }

        // Handoff worth it? With 0–1 remaining todos the swap overhead
        // exceeds any savings.
        if (st.todosRemaining === 0) {
          toast("prewalk: plan already completed in the frontier phase — no handoff needed", "success")
          await log("info", "prewalk: nothing left to hand off", { sessionID })
          states.delete(sessionID)
          return
        }
        if (st.todosRemaining === 1) {
          const wasAuto = !!st.executor
          st.phase = "executor" // prunes the planning instruction; model stays as-is
          st.executor = undefined
          toast("prewalk: only 1 todo left — handoff skipped, finishing on the current model")
          await log("info", "prewalk: handoff skipped (1 todo left)", { sessionID })
          if (wasAuto) {
            await client.session
              .prompt({
                path: { id: sessionID },
                body: { parts: [{ type: "text", text: executorKickoff }] },
              })
              .catch(() => {})
          }
          return
        }

        if (st.executor) {
          // ------- auto mode: swap now -------
          st.phase = "executor"
          toast(`prewalk: automatic handoff → ${modelLabel(st.executor)}`, "success")
          await log("info", "prewalk: auto handoff", { sessionID, executor: modelLabel(st.executor) })
          await client.session
            .prompt({
              path: { id: sessionID },
              body: {
                model: st.executor,
                parts: [{ type: "text", text: executorKickoff }],
              },
            })
            .catch(async (e: any) => {
              st.phase = "paused"
              toast("prewalk: auto-swap failed — switch manually (/models + continue)", "warning")
              await log("warn", "prewalk: auto handoff failed", { sessionID, error: `${e}` })
            })
        } else {
          // ------- manual mode: checkpoint -------
          st.phase = "paused"
          toast(
            "prewalk ⏸️ PAUSE — review the plan and task #1, switch model, then send 'continue'",
            "success",
          )
        }
        return
      }

      if (st.phase === "executor") {
        if (st.todosRemaining > 0 && st.nudgeEnabled && st.nudges < 2) {
          st.nudges++
          await log("info", "prewalk: nudging executor", { sessionID, remaining: st.todosRemaining })
          await client.session
            .prompt({
              path: { id: sessionID },
              body: {
                ...(st.executor ? { model: st.executor } : {}),
                parts: [{ type: "text", text: nudgeMessage }],
              },
            })
            .catch(() => {})
        } else if (st.todosRemaining === 0 && st.todoCreated) {
          toast("prewalk: all todos completed ✅", "success")
          states.delete(sessionID)
        }
      }
    },
  }
}
