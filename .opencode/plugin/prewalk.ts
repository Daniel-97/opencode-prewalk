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
} from "./prewalk-helpers"
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
  // After swapToExecutor we watch the next user message written by the server
  // and check its `agent` field matches the executor, so a silently failed /
  // fallback-to-default swap surfaces as an error toast instead of going
  // undetected until the user inspects an export.
  awaitingSwapVerification?: boolean
  verifiedMessageID?: string
}

interface PrewalkDefaults {
  maxTodos: number
  confirmations: string[]
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
      const definition = {
        description:
          "Prewalk — frontier explores, plans, lands the first edit; then hands off to the executor",
        template: "$ARGUMENTS",
        agent: AGENT_FRONTIER,
      }
      // Don't clobber commands the user defined with the same names.
      config.command.prewalk = config.command.prewalk ?? definition
      config.command.pw = config.command.pw ?? definition
    },

    // -----------------------------------------------------------------------
    // 1) Detect the /prewalk trigger, parse --no-pause, init session state,
    //    and strip the flag from the message the model will see.
    // -----------------------------------------------------------------------
    "command.execute.before": async (input, output) => {
      if (input.command !== "prewalk" && input.command !== "pw") return
      const sessionID = input.sessionID
      if (!sessionID) return

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

          st.todosRemaining = countRemaining(todos)
          const pausePresent = todos.some(isPauseTodo)
          if (pausePresent) st.pauseSeen = true

          if (st.phase === "executor") {
            if (st.todosRemaining === 0) {
              toast("prewalk: all todos completed ✅", "success")
              await log("info", "prewalk: executor finished", { sessionID })
              states.delete(sessionID)
            }
            return
          }

          // frontier / paused: only act at the ⏸️ checkpoint.
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
            // Swap overhead exceeds the savings for a single todo — finish on
            // the current agent, no swap, no kickoff.
            st.phase = "executor"
            toast("prewalk: only 1 todo left — handoff skipped, finishing on the current agent")
            await log("info", "prewalk: handoff skipped (1 todo left)", { sessionID })
            return
          }

          if (st.autoSwap) {
            await swapToExecutor(sessionID, st)
          } else if (st.phase === "frontier") {
            st.phase = "paused"
            toast(
              "prewalk ⏸️ PAUSE — review the plan and task #1, then send a confirmation (e.g. 'continue') to hand off, or a revision request",
              "success",
            )
            await log("info", "prewalk: paused at checkpoint", { sessionID })
          } else {
            // paused (revision loop): re-confirm the checkpoint quietly.
            toast("prewalk: plan updated — review and confirm to hand off, or send another revision request", "info")
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

          // Post-swap verification: the first user message the server writes
          // after swapToExecutor (the kickoff) must carry agent === executor.
          // If it carries the session's default agent instead, the persistent
          // switch silently failed and the executor never took over — surface
          // it loudly instead of letting it masquerade as success.
          if (st.phase === "executor" && st.awaitingSwapVerification) {
            if (st.verifiedMessageID === info.id || st.lastHandledUserMessageID === info.id) return
            const actualAgent = info.agent
            if (actualAgent === AGENT_EXECUTOR) {
              st.awaitingSwapVerification = false
              st.verifiedMessageID = info.id
              await log("info", "prewalk: swap verified", {
                sessionID: info.sessionID,
                agent: actualAgent,
                model: info.model ? modelLabel(info.model) : null,
              })
            } else {
              st.awaitingSwapVerification = false
              st.verifiedMessageID = info.id
              toast(
                `prewalk: swap NON riuscito — il messaggio successivo gira su agent ` +
                  `"${actualAgent}", atteso "${AGENT_EXECUTOR}". Verifica ` +
                  `.opencode/agent/prewalk-executor.md e \`opencode agent list\`.`,
                "warning",
              )
              await log("warn", "prewalk: swap verification failed", {
                sessionID: info.sessionID,
                expected: AGENT_EXECUTOR,
                actual: actualAgent,
              })
            }
            return
          }

          if (st.phase !== "paused") return
          if (st.lastHandledUserMessageID === info.id) return
          st.lastHandledUserMessageID = info.id

          const text = await fetchMessageText(info.sessionID, info.id).catch(() => "")
          if (isConfirmation(text, st.confirmations)) {
            await swapToExecutor(info.sessionID, st)
          } else {
            // Revision request: do NOT swap. The message is delivered to the
            // session's current agent (still prewalk-frontier); stay paused.
            await log("info", "prewalk: revision request received — staying on frontier", {
              sessionID: info.sessionID,
            })
          }
          return
        }

        default:
          return
      }
    },
  }
}