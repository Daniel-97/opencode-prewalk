/**
 * opencode-prewalk — Prewalk technique for OpenCode (stable plugin API)
 *
 * Technique by Can Bölük / Stencil: https://stencil.so/blog/prewalk
 * Skill/prompt structure inspired by westfable/hermes-prewalk (MIT).
 *
 * Flow:
 *   /prewalk <task> [--no-pause]
 *
 *   Phase "frontier":  the `prewalk-frontier` agent (its system prompt and
 *                      pinned model are baked into .opencode/agent/prewalk-frontier.md)
 *                      explores, creates a todo list, completes task #1, adds a
 *                      ⏸️ checkpoint todo and stops.
 *   Swap gate:         the ⏸️ checkpoint todo is added (detected via the stable
 *                      `todo.updated` event, recognized by the leading "⏸️" marker).
 *   Checkpoint:        the plugin pauses the session and toasts the user.
 *                      - manual mode (default) -> the user reviews the plan; a
 *                        confirmation message swaps to the `prewalk-executor`
 *                        agent, a revision request is left for the frontier agent.
 *                      - auto mode (`--no-pause`) -> the plugin swaps immediately.
 *   Phase "executor":  the `prewalk-executor` agent takes over (prompt + model
 *                      baked into .opencode/agent/prewalk-executor.md).
 *
 * The persistent agent/model switch at the checkpoint uses the v2 SDK
 * (`@opencode-ai/sdk/v2`) switchAgent/switchModel endpoints — the v1
 * `session.prompt({ agent })` is only a per-turn override and does not change
 * the session's selected agent, so it cannot reliably hand off. Hooks/events
 * used: `config`, `command.execute.before`, and the stable events
 * `session.created`, `session.deleted`, `todo.updated`, `message.updated`.
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
} from "./prewalk-helpers"
import fs from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------

type Phase = "idle" | "frontier" | "paused" | "executor"

interface PrewalkState {
  phase: Phase
  autoSwap: boolean
  pauseSeen: boolean
  todosRemaining: number
  maxTodos: number
  confirmations: string[]
  lastHandledUserMessageID?: string
  readyToSwap?: boolean      // P4: auto-swap deferred to session.idle
  frontierTodosEverSeen?: boolean // P11: detect trivial path
  pendingFrontierContinue?: boolean // P5: single-todo continuation pending
}

interface PrewalkDefaults {
  maxTodos: number
  confirmations: string[]
  executor?: { providerID: string; modelID: string }
}

const VERSION = "0.2.0"

const DEFAULT_CONFIRMATIONS = [
  "",
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
  "Continue from the checkpoint: check off the ⏸️ PAUSE todo and proceed with " +
  "the remaining todos in order, one at a time, verifying each before moving on."

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

  // The stable v1 client (`client`) exposes no persistent agent-switch call:
  // `session.prompt({ agent })` is a per-turn override that does NOT change the
  // session's selected agent, so subsequent user messages fall back to the
  // session's default agent (e.g. `build`). The persistent switch lives in the
  // v2 API under the nested `.v2` namespace: `POST /api/session/{id}/agent`
  // ("Switch the agent used by subsequent provider turns"). We build a v2
  // client bound to the same server therefore.
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

  /** Resolve the model pinned on an agent definition, if any. */
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

  /** Persistently switch this session's selected agent+model, then kick off. */
  const swapToExecutor = async (sessionID: string, st: PrewalkState) => {
    const executorModel = await resolveAgentModel(AGENT_EXECUTOR)
    await log("info", "prewalk: swap → sending", {
      sessionID,
      agent: AGENT_EXECUTOR,
      model: executorModel ? modelLabel(executorModel) : null,
    })

    // 1) Persistent V2 agent/model switch — best-effort. It updates the UI
    //    "agent switched" marker and the session's V2 state, but is NOT the
    //    source of truth for the executor turn: the kickoff below carries an
    //    explicit per-turn `agent`+`model` override (the only thing V1
    //    createUserMessage actually consults). So failures here are warnings.
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

    // 2) Kickoff with explicit per-turn agent+model — this is the override
    //    createUserMessage actually honors. `model` shape is { providerID, modelID }
    //    (V1), NOT the V2 { id, providerID } used by switchModel above.
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
    // 0) Register the /prewalk command (+ alias /pw) on the frontier agent.
    //    The agent (prompt + pinned model) lives in
    //    .opencode/agent/prewalk-frontier.md — the single source of truth.
    // -----------------------------------------------------------------------
    config: async (config: Config) => {
      config.command = config.command ?? {}
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
      }
      const reviseCmd = {
        description: "Prewalk — revise the plan on the frontier agent",
        template: "$ARGUMENTS",
        agent: AGENT_FRONTIER,
      }
      // Use distinct objects (App.A): a mutation of one must not leak into another.
      config.command.prewalk = config.command.prewalk ?? structuredClone(frontierCmd)
      config.command.pw = config.command.pw ?? structuredClone(frontierCmd)
      config.command["pw-go"] = config.command["pw-go"] ?? structuredClone(goCmd)
      config.command.pwg = config.command.pwg ?? structuredClone(goCmd)
      config.command["pw-revise"] = config.command["pw-revise"] ?? structuredClone(reviseCmd)
      config.command.pwr = config.command.pwr ?? structuredClone(reviseCmd)
    },

    // -----------------------------------------------------------------------
    // 1) Detect the /prewalk trigger, parse --no-pause, init session state,
    //    and strip the flag from the message the model will see.
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
        const textPart = output.parts.find((p): p is TextPart => p.type === "text")
        if (textPart) textPart.text = cleanTask
        else output.parts = [{ id: "", sessionID: "", messageID: "", type: "text", text: cleanTask } as TextPart]
        await log("info", "prewalk: frontier phase started", { sessionID, auto: autoSwap })
        toast(
          autoSwap
            ? "prewalk started — auto-swap at the checkpoint"
            : "prewalk started — manual checkpoint at the ⏸️ todo",
        )
        return
      }

      const st = states.get(sessionID)
      if (!st) return

      if (isGo) {
        // The command template is the kickoff text and the command's own `agent`
        // is AGENT_EXECUTOR. We just advance the state machine; the model pin is
        // resolved here and used as a per-turn override via the command's `model`
        // once OpenCode surfaces such a field — until then rely on the agent pin
        // (Task 4 emits a warning when there is no pin and no `prewalk.json`
        // `executor` override).
        const executorModel = await resolveAgentModel(AGENT_EXECUTOR)
        if (!executorModel) {
          toast(
            `prewalk: ${AGENT_EXECUTOR} has no pinned model — the handoff will NOT change model or cost. ` +
              `Pin a cheaper model in .opencode/agent/prewalk-executor.md or set "executor" in prewalk.json`,
            "warning",
          )
          await log("warn", "prewalk: executor has no pinned model", { sessionID })
        }
        st.phase = "executor"
        await log("info", "prewalk: /pw-go handoff", { sessionID })
        return
      }

      // isRevise: stay paused, the command routes the revision text to the
      // frontier agent (command.agent === AGENT_FRONTIER). The frontier's own
      // prompt already tells it to re-add the ⏸️ checkpoint after revising.
      if (st.phase !== "paused") return
      await log("info", "prewalk: /pw-revise revision received — staying on frontier", { sessionID })
      toast("prewalk: plan revised on the frontier — review and /pw-go when ready", "info")
    },

    // -----------------------------------------------------------------------
    // 2) Session lifecycle + checkpoint detection + confirmation handling,
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

          if (st.phase === "frontier" && todos.length > 0) st.frontierTodosEverSeen = true

          st.todosRemaining = countRemaining(todos)
          const pausePresent = todos.some(isPauseTodo)
          if (pausePresent) st.pauseSeen = true

          // If this update contains no ⏸️ pause todo, it's not a checkpoint
          // event — skip the checkpoint/guardrail logic entirely.
          if (!pausePresent) return

          const real = todos.filter((t) => !isPauseTodo(t)).length
          if (st.phase === "frontier" && real > st.maxTodos) {
            toast(`prewalk: ${real} todos > cap ${st.maxTodos} — plan may be too large`, "warning")
          }

          if (st.phase === "executor") {
            if (st.todosRemaining === 0) {
              toast("prewalk: all todos completed ✅", "success")
              await log("info", "prewalk: executor finished", { sessionID })
              states.delete(sessionID)
            }
            return
          }

          if (st.todosRemaining === 0) {
            toast("prewalk: plan already completed in the frontier phase — no handoff needed", "success")
            await log("info", "prewalk: nothing left to hand off", { sessionID })
            states.delete(sessionID)
            return
          }
          if (st.todosRemaining === 1) {
            // P5: a single remaining todo is not worth a model swap. In auto mode
            // defer a frontier continuation prompt to session.idle so the frontier's
            // current turn completes. In manual mode stay passive with an honest toast.
            if (st.autoSwap) {
              st.phase = "executor" // honorary "executor" so the completion toast fires when this todo resolves
              st.readyToSwap = false
              st.pendingFrontierContinue = true
            } else {
              st.phase = "paused"
              toast("prewalk: only 1 todo left — no handoff. Send any message to finish on the current agent, or tick the todo off manually.")
              await log("info", "prewalk: 1 todo left — passive manual", { sessionID })
            }
            return
          }

          if (st.autoSwap) {
            st.readyToSwap = true // P4: actually swap on session.idle, not mid-turn
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

        // ---- user response at the checkpoint, and post-swap verification ----
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

        case "session.idle": {
          const sessionID = event.properties.sessionID
          const st = states.get(sessionID)
          if (!st) return

          // P11: trivial path — frontier finished without ever adding a todo list.
          if (st.phase === "frontier" && !st.pauseSeen && !st.frontierTodosEverSeen) {
            st.phase = "idle"
            await log("info", "prewalk: trivial path — protocol not engaged", { sessionID })
            return
          }

          // P4 defense: the frontier produced a todo list but never the ⏸️ checkpoint.
          if (st.phase === "frontier" && st.frontierTodosEverSeen && !st.pauseSeen) {
            toast("prewalk: checkpoint todo not detected — check the todo list format", "warning")
            await log("warn", "prewalk: frontier finished with todos but no ⏸️ checkpoint", { sessionID })
          }

          // P4: deferred auto-swap once the frontier turn has fully completed.
          if (st.phase === "frontier" && st.autoSwap && st.readyToSwap) {
            st.readyToSwap = false
            await swapToExecutor(sessionID, st)
            return
          }

          // P5: auto-mode continuation for the single-todo case (agent stays frontier).
          if (st.phase === "executor" && st.pendingFrontierContinue) {
            st.pendingFrontierContinue = false
            await client.session
              .prompt({
                path: { id: sessionID },
                body: {
                  agent: AGENT_FRONTIER,
                  parts: [
                    {
                      type: "text",
                      text:
                        "Only one todo remains: check off the ⏸️ PAUSE item and complete the last todo now, verifying it before marking it completed.",
                    },
                  ],
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