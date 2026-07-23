/**
 * opencode-prewalk — Prewalk technique for OpenCode (stable plugin API)
 *
 * Technique by Can Bölük / Stencil: https://stencil.so/blog/prewalk
 * Skill/prompt structure inspired by westfable/hermes-prewalk (MIT).
 *
 * Flow:
 *   /prewalk <task> [--no-pause]   (alias /pw)
 *
 *   Phase "frontier":  the `prewalk-frontier` agent (prompt + optional model pin
 *                      in .opencode/agent/prewalk-frontier.md) explores, creates
 *                      a todo list, completes task #1, adds a ⏸️ checkpoint todo
 *                      and stops.
 *   Swap gate:         the ⏸️ checkpoint todo is detected via the stable
 *                      `todo.updated` event (marker: "⏸ PAUSE" / "PAUSE" / "[PAUSE]").
 *   Checkpoint:
 *     - manual mode (default): the plugin pauses and toasts. `/pw-go` (alias
 *       /pwg) confirms and hands off — the command itself carries
 *       agent=prewalk-executor, so the handoff is race-free. `/pw-revise <text>`
 *       (alias /pwr) routes a revision to the frontier agent. Free-form
 *       "continue"-style confirmations still work as a deprecated fallback.
 *     - auto mode (--no-pause): the swap is deferred to `session.idle` so the
 *       frontier turn (including its summary) completes, then the plugin sends
 *       the kickoff itself.
 *   Phase "executor":  the `prewalk-executor` agent works the remaining todos.
 *
 * How the swap actually works: the ONLY mechanism OpenCode's V1 prompt path
 * honors is the per-turn `agent`/`model` override on the prompt (or the
 * `agent`/`model` fields of a command). Prompts sent WITHOUT `agent` resolve to
 * the configured default agent — NOT to any previously "switched" agent. The
 * V2 switchAgent/switchModel endpoints only update V2 session state and the UI
 * "agent switched" marker, so they are called best-effort and never trusted
 * for the handoff itself.
 *
 * Hooks/events used: `config`, `command.execute.before`, and the stable events
 * `session.created`, `session.deleted`, `todo.updated`, `message.updated`,
 * `session.idle`.
 */

import type { Plugin, Config } from "@opencode-ai/plugin"
import type { Event, Todo, Agent, TextPart, Part, Message } from "@opencode-ai/sdk"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2"
import {
  AGENT_FRONTIER,
  AGENT_EXECUTOR,
  isPauseTodo,
  countRemaining,
  isConfirmation,
  parseExecutorModel,
} from "./lib/prewalk-helpers"
import fs from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------

type Phase = "idle" | "frontier" | "paused" | "executor"

interface PrewalkState {
  phase: Phase
  autoSwap: boolean // --no-pause -> swap without waiting for confirmation
  pauseSeen: boolean
  todosRemaining: number
  maxTodos: number
  confirmations: string[]
  lastHandledUserMessageID?: string
  readyToSwap?: boolean // R/P4: auto-swap deferred to session.idle
  frontierTodosEverSeen?: boolean // P11: distinguish trivial path from anomaly
  anomalyWarned?: boolean // one-shot guard for the missing-checkpoint warning
  pendingFrontierContinue?: boolean // P5: single-todo auto continuation pending
}

interface PrewalkDefaults {
  maxTodos: number
  confirmations: string[]
  executor?: { providerID: string; modelID: string }
}

const VERSION = "0.3.0"

const DEFAULT_CONFIRMATIONS = [
  "continue",
  "ok",
  "go",
  "yes",
  "proceed",
  "y",
  "next",
  "done",
]

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const executorKickoff =
  "Check off the ⏸️ PAUSE todo and proceed with the remaining todos in order, one at a time, " +
  "verifying each before marking it completed."

const singleTodoContinue =
  "Only one todo remains: check off the ⏸️ PAUSE item and complete the last todo now, " +
  "verifying it before marking it completed."

const noActiveRunNoop =
  "There is no active prewalk checkpoint in this session. " +
  "Reply with a single line saying so and end your turn — do not touch the todo list or any file."

const noPinWarning =
  `prewalk: ${AGENT_EXECUTOR} has no pinned model — the handoff will NOT change model or cost. ` +
  `Pin a cheaper model in .opencode/agent/prewalk-executor.md or set "executor" in .opencode/prewalk.json`

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadDefaults(directory: string): PrewalkDefaults {
  const out: PrewalkDefaults = {
    maxTodos: 12,
    confirmations: DEFAULT_CONFIRMATIONS,
  }
  try {
    const p = path.join(directory, ".opencode", "prewalk.json")
    const raw: unknown = JSON.parse(fs.readFileSync(p, "utf8"))
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>
      if (Number.isInteger(o.maxTodos)) out.maxTodos = o.maxTodos as number
      if (Array.isArray(o.confirmations)) {
        const cs = o.confirmations.filter((c): c is string => typeof c === "string")
        if (cs.length > 0) out.confirmations = cs
      }
      if (typeof o.executor === "string") {
        const parsed = parseExecutorModel(o.executor)
        if (parsed) out.executor = parsed
      }
    }
  } catch {
    /* no config file — use defaults */
  }
  return out
}

function initialState(defaults: PrewalkDefaults, autoSwap: boolean): PrewalkState {
  return {
    phase: "frontier",
    autoSwap,
    pauseSeen: false,
    todosRemaining: 0,
    maxTodos: defaults.maxTodos,
    confirmations: defaults.confirmations,
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const PrewalkPlugin: Plugin = async ({ client, directory, serverUrl }) => {
  const dir = directory ?? process.cwd()
  const defaults = loadDefaults(dir)
  const states = new Map<string, PrewalkState>()

  // V2 client for the best-effort switchAgent/switchModel calls (they update
  // the V2 session state and the UI "agent switched" marker). They are NOT the
  // source of truth for the handoff — see the header comment.
  const v2client = createV2Client({
    baseUrl: serverUrl?.origin ?? "http://localhost:4096",
    directory: dir,
  })

  const log = (
    level: "info" | "warn",
    message: string,
    extra?: Record<string, unknown>,
  ) =>
    client.app
      .log({ body: { service: "prewalk", level, message, extra } })
      .catch(() => {})

  const toast = (
    message: string,
    variant: "info" | "success" | "warning" = "info",
  ) =>
    client.tui?.showToast?.({ body: { message, variant } }).catch?.(() => {})

  const modelLabel = (m?: { providerID: string; modelID: string }) =>
    m ? `${m.providerID}/${m.modelID}` : "?"

  await log("info", "prewalk plugin loaded", { version: VERSION })

  /** Resolve the executor model: prewalk.json `executor` wins over the agent-file pin. */
  const resolveAgentModel = async (agentName: string) => {
    if (agentName === AGENT_EXECUTOR && defaults.executor) return defaults.executor
    try {
      const res = await client.app.agents({ query: { directory: dir } })
      const agents: Agent[] = res.data ?? []
      return agents.find((a) => a.name === agentName)?.model
    } catch {
      return undefined
    }
  }

  /**
   * R1: `command.execute.before` cannot cancel a command — the turn runs no
   * matter what. When a prewalk command is invalid in the current state, the
   * best we can do is rewrite its parts into an explicit no-op instruction so
   * the model does nothing instead of executing a stale kickoff/revision.
   */
  const neutralize = (output: { parts: Part[] }, text: string) => {
    const textPart = output.parts.find((p): p is TextPart => p.type === "text")
    if (textPart) textPart.text = text
    else
      output.parts = [
        { id: "", sessionID: "", messageID: "", type: "text", text } as TextPart,
      ]
  }

  /** Hand off to the executor: best-effort V2 switch, then explicit kickoff. */
  const swapToExecutor = async (sessionID: string, st: PrewalkState) => {
    const executorModel = await resolveAgentModel(AGENT_EXECUTOR)
    await log("info", "prewalk: swap → sending", {
      sessionID,
      agent: AGENT_EXECUTOR,
      model: executorModel ? modelLabel(executorModel) : null,
    })

    // R3: without a pinned model (agent file or prewalk.json) the swap changes
    // agent but not model — the cost savings that motivate prewalk do not
    // apply. Never let that happen silently.
    if (!executorModel) {
      toast(noPinWarning, "warning")
      await log("warn", "prewalk: executor has no pinned model", { sessionID })
    }

    // 1) Best-effort persistent V2 switch (UI marker + V2 state). Failures are
    //    warnings only: the kickoff below carries the explicit per-turn
    //    override, which is the only thing the V1 prompt path honors.
    try {
      await v2client.v2.session.switchAgent({ sessionID, agent: AGENT_EXECUTOR })
      if (executorModel) {
        try {
          await v2client.v2.session.switchModel({
            sessionID,
            model: { id: executorModel.modelID, providerID: executorModel.providerID },
          })
        } catch (e: unknown) {
          await log("warn", "prewalk: switchModel failed (continuing)", {
            sessionID,
            model: modelLabel(executorModel),
            error: `${e}`,
          })
        }
      }
    } catch (e: unknown) {
      await log("warn", "prewalk: switchAgent failed (kicking off with per-turn override)", {
        sessionID,
        agent: AGENT_EXECUTOR,
        error: `${e}`,
      })
    }

    st.phase = "executor"

    // 2) Kickoff with explicit per-turn agent+model — this is the override the
    //    V1 prompt path actually honors. NOTE: the V1 `model` shape is
    //    { providerID, modelID }, not the V2 { id, providerID } used above.
    await client.session
      .prompt({
        path: { id: sessionID },
        body: {
          agent: AGENT_EXECUTOR,
          ...(executorModel
            ? { model: { providerID: executorModel.providerID, modelID: executorModel.modelID } }
            : {}),
          parts: [{ type: "text", text: executorKickoff }],
        },
      })
      .catch(async (e: unknown) => {
        toast("prewalk: handoff failed — continue manually on the executor agent", "warning")
        await log("warn", "prewalk: kickoff failed", { sessionID, error: `${e}` })
      })
  }

  /** Fetch the text content of a message from the server. */
  const fetchMessageText = async (sessionID: string, messageID: string): Promise<string> => {
    const res = await client.session.message({ path: { id: sessionID, messageID } })
    const parts: Part[] = res.data?.parts ?? []
    return parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim()
  }

  return {
    // -----------------------------------------------------------------------
    // 0) Register the commands. Each command carries its own `agent` (and, for
    //    /pw-go, the `model` from prewalk.json when set) — command agent/model
    //    routing is the one reliable per-turn override in the V1 flow.
    // -----------------------------------------------------------------------
    config: async (config: Config) => {
      config.command = config.command ?? {}
      const executorModelPin = defaults.executor
        ? `${defaults.executor.providerID}/${defaults.executor.modelID}`
        : undefined
      const frontierCmd = {
        description:
          "Prewalk — frontier explores, plans, lands the first edit; then hands off to the executor",
        template: "$ARGUMENTS",
        agent: AGENT_FRONTIER,
      }
      const goCmd = {
        description: "Prewalk — confirm the plan and hand off to the executor now",
        template: executorKickoff,
        agent: AGENT_EXECUTOR,
        // R3: `model` on a command IS supported by OpenCode and takes
        // precedence over the agent-file pin, so the prewalk.json `executor`
        // override applies to /pw-go too. Multi-segment IDs are safe: the
        // server parses "provider/rest/of/id" splitting on the first slash.
        ...(executorModelPin ? { model: executorModelPin } : {}),
      }
      const reviseCmd = {
        description: "Prewalk — revise the plan on the frontier agent",
        template: "$ARGUMENTS",
        agent: AGENT_FRONTIER,
      }
      // Use distinct objects: a mutation of one must not leak into another.
      config.command.prewalk = config.command.prewalk ?? structuredClone(frontierCmd)
      config.command.pw = config.command.pw ?? structuredClone(frontierCmd)
      config.command["pw-go"] = config.command["pw-go"] ?? structuredClone(goCmd)
      config.command.pwg = config.command.pwg ?? structuredClone(goCmd)
      config.command["pw-revise"] = config.command["pw-revise"] ?? structuredClone(reviseCmd)
      config.command.pwr = config.command.pwr ?? structuredClone(reviseCmd)
    },

    // -----------------------------------------------------------------------
    // 1) Command handling: /prewalk starts a run; /pw-go and /pw-revise drive
    //    the checkpoint. Invalid invocations are neutralized (see R1 note).
    // -----------------------------------------------------------------------
    "command.execute.before": async (input, output) => {
      const isPrewalk = input.command === "prewalk" || input.command === "pw"
      const isGo = input.command === "pw-go" || input.command === "pwg"
      const isRevise = input.command === "pw-revise" || input.command === "pwr"
      if (!isPrewalk && !isGo && !isRevise) return
      const sessionID = input.sessionID
      if (!sessionID) return

      if (isPrewalk) {
        const args = input.arguments ?? ""
        const autoSwap = /--no-pause\b/.test(args)
        states.set(sessionID, initialState(defaults, autoSwap))
        const cleanTask = args
          .replace(/--no-pause\b/g, "")
          .replace(/\s+/g, " ")
          .trim() || "Proceed with the task."
        neutralize(output, cleanTask)
        await log("info", "prewalk: frontier phase started", { sessionID, auto: autoSwap })
        toast(
          autoSwap
            ? "prewalk started — auto-swap at the checkpoint"
            : "prewalk started — manual checkpoint at the ⏸️ todo",
        )
        return
      }

      const st = states.get(sessionID)
      const atCheckpoint = st !== undefined && st.phase === "paused"

      if (isGo) {
        if (!atCheckpoint) {
          neutralize(output, noActiveRunNoop)
          toast(
            "prewalk: /pw-go is only valid at the ⏸️ checkpoint — run /prewalk and wait for the PAUSE todo",
            "warning",
          )
          await log("warn", "prewalk: /pw-go outside checkpoint — neutralized", { sessionID })
          return
        }
        // The command template is the kickoff text; the command's own `agent`
        // (and `model`, when prewalk.json sets `executor`) route the turn.
        // Here we only warn on a missing pin and advance the state machine.
        const executorModel = await resolveAgentModel(AGENT_EXECUTOR)
        if (!executorModel) {
          toast(noPinWarning, "warning")
          await log("warn", "prewalk: executor has no pinned model", { sessionID })
        }
        st.phase = "executor"
        await log("info", "prewalk: /pw-go handoff", {
          sessionID,
          model: executorModel ? modelLabel(executorModel) : null,
        })
        return
      }

      // isRevise
      if (!atCheckpoint) {
        neutralize(output, noActiveRunNoop)
        toast("prewalk: /pw-revise is only valid at the ⏸️ checkpoint — nothing to revise", "warning")
        await log("warn", "prewalk: /pw-revise outside checkpoint — neutralized", { sessionID })
        return
      }
      // Stay paused: the command routes the revision text to the frontier
      // agent (command.agent === AGENT_FRONTIER), whose prompt re-adds the ⏸️
      // checkpoint after revising.
      await log("info", "prewalk: /pw-revise revision received — staying on frontier", { sessionID })
      toast("prewalk: plan revised on the frontier — review and /pw-go when ready", "info")
    },

    // -----------------------------------------------------------------------
    // 2) Session lifecycle + checkpoint detection + legacy confirmations,
    //    all through the stable `event` hook.
    // -----------------------------------------------------------------------
    event: async ({ event }: { event: Event }) => {
      switch (event.type) {
        // ---- lifecycle: bind state to the session ----
        case "session.created": {
          const id = event.properties.info.id
          // Don't overwrite a prewalk already in flight (in case the command
          // hook fired before the session.created event arrived).
          if (!states.has(id)) {
            states.set(id, {
              phase: "idle",
              autoSwap: false,
              pauseSeen: false,
              todosRemaining: 0,
              maxTodos: defaults.maxTodos,
              confirmations: defaults.confirmations,
            })
          }
          return
        }
        case "session.deleted": {
          states.delete(event.properties.info.id)
          return
        }

        // ---- checkpoint / guardrails / completion, driven by the todo list ----
        case "todo.updated": {
          const sessionID = event.properties.sessionID
          const st = states.get(sessionID)
          if (!st || st.phase === "idle") return
          const todos: Todo[] = event.properties.todos ?? []
          if (todos.length === 0) return

          if (st.phase === "frontier") st.frontierTodosEverSeen = true

          st.todosRemaining = countRemaining(todos)
          const pausePresent = todos.some(isPauseTodo)
          if (pausePresent) st.pauseSeen = true

          // R2: executor completion detection must NOT depend on the ⏸️ todo
          // still being present — models sometimes rewrite the list without it.
          // Keep this branch ABOVE the pause-present guard.
          if (st.phase === "executor") {
            if (st.todosRemaining === 0) {
              toast("prewalk: all todos completed ✅", "success")
              await log("info", "prewalk: executor finished", { sessionID })
              states.delete(sessionID)
            }
            return
          }

          // frontier / paused: everything below is checkpoint logic, which only
          // makes sense when the ⏸️ todo is part of the update.
          if (!pausePresent) return

          const real = todos.filter((t) => !isPauseTodo(t)).length
          if (st.phase === "frontier" && real > st.maxTodos) {
            toast(`prewalk: ${real} todos > cap ${st.maxTodos} — plan may be too large`, "warning")
          }

          if (st.todosRemaining === 0) {
            toast("prewalk: plan already completed in the frontier phase — no handoff needed", "success")
            await log("info", "prewalk: nothing left to hand off", { sessionID })
            states.delete(sessionID)
            return
          }
          if (st.todosRemaining === 1) {
            // P5: a single remaining todo is not worth a model swap. Move to
            // "executor" in BOTH modes: it arms completion detection, disarms
            // the paused-phase legacy handlers, and makes /pw-go invalid (a
            // handoff for one todo would contradict this very guardrail).
            st.phase = "executor"
            st.readyToSwap = false
            if (st.autoSwap) {
              // Continuation deferred to session.idle so the frontier turn
              // completes first.
              st.pendingFrontierContinue = true
            } else {
              toast(
                "prewalk: only 1 todo left — no handoff. Ask the model to finish it (any message stays on the agent selected in the TUI).",
              )
              await log("info", "prewalk: 1 todo left — finishing without handoff (manual)", { sessionID })
            }
            return
          }

          if (st.autoSwap) {
            st.readyToSwap = true // swap on session.idle, not mid-turn
            return
          }

          if (st.phase === "frontier") {
            st.phase = "paused"
            toast(
              "prewalk ⏸️ PAUSE — review the plan and task #1, then run `/pw-go` to hand off, or `/pw-revise <changes>` to revise",
              "success",
            )
            await log("info", "prewalk: paused at checkpoint", { sessionID })
          } else {
            toast("prewalk: plan updated — review and `/pw-go` to hand off, or `/pw-revise <changes>` again", "info")
            await log("info", "prewalk: re-paused after revision", { sessionID })
          }
          return
        }

        // ---- legacy free-form confirmations at the checkpoint (deprecated) ----
        case "message.updated": {
          const info: Message | undefined = event.properties.info
          if (!info || info.role !== "user" || info.sessionID === undefined) return
          const st = states.get(info.sessionID)
          if (!st) return

          if (st.phase !== "paused") return
          if (st.lastHandledUserMessageID === info.id) return
          st.lastHandledUserMessageID = info.id

          const text = await fetchMessageText(info.sessionID, info.id).catch(() => "")
          if (isConfirmation(text, st.confirmations)) {
            toast(
              "prewalk: free-form confirmation is deprecated — use `/pw-go` to hand off reliably. Attempting handoff now…",
              "warning",
            )
            await log("info", "prewalk: legacy confirmation — falling back to swapToExecutor", {
              sessionID: info.sessionID,
            })
            await swapToExecutor(info.sessionID, st)
          } else {
            await log("info", "prewalk: revision request received — staying on frontier; prefer /pw-revise", {
              sessionID: info.sessionID,
            })
            toast("prewalk: prefer `/pw-revise <changes>` to revise reliably — legacy revision kept on frontier", "info")
          }
          return
        }

        // ---- end-of-turn work: deferred swap, single-todo continue, cleanup ----
        case "session.idle": {
          const sessionID = event.properties.sessionID
          const st = states.get(sessionID)
          if (!st) return

          // P11: trivial path — frontier finished without ever creating a todo
          // list (the prompt-level escape). Close the run cleanly.
          if (st.phase === "frontier" && !st.pauseSeen && !st.frontierTodosEverSeen) {
            st.phase = "idle"
            await log("info", "prewalk: trivial path — protocol not engaged", { sessionID })
            return
          }

          // Anomaly: the frontier produced a todo list but never the ⏸️
          // checkpoint. Warn once and close the run — leaving the state in
          // "frontier" forever would make a much later ⏸️ todo resurrect it.
          if (st.phase === "frontier" && st.frontierTodosEverSeen && !st.pauseSeen) {
            if (!st.anomalyWarned) {
              st.anomalyWarned = true
              toast("prewalk: checkpoint todo not detected — check the todo list format", "warning")
              await log("warn", "prewalk: frontier finished with todos but no ⏸️ checkpoint", { sessionID })
            }
            st.phase = "idle"
            return
          }

          // Deferred auto-swap once the frontier turn has fully completed.
          if (st.phase === "frontier" && st.autoSwap && st.readyToSwap) {
            st.readyToSwap = false
            await swapToExecutor(sessionID, st)
            return
          }

          // P5: auto-mode continuation for the single-todo case. No model
          // swap: one todo does not justify it — stay on the frontier agent.
          if (st.phase === "executor" && st.pendingFrontierContinue) {
            st.pendingFrontierContinue = false
            await client.session
              .prompt({
                path: { id: sessionID },
                body: {
                  agent: AGENT_FRONTIER,
                  parts: [{ type: "text", text: singleTodoContinue }],
                },
              })
              .catch(async (e: unknown) => {
                toast("prewalk: auto-continue failed — finish the last todo manually", "warning")
                await log("warn", "prewalk: single-todo continue failed", { sessionID, error: `${e}` })
              })
            return
          }

          return
        }

        default:
          return
      }
    },
  }
}