import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isPauseTodo,
  countRemaining,
  isConfirmation,
  parseExecutorModel,
} from "../.opencode/plugin/lib/prewalk-helpers"

test("isPauseTodo accepts the emoji marker with and without the variation selector (P7)", () => {
  assert.equal(isPauseTodo({ content: "⏸️ PAUSE — handoff" }), true)
  assert.equal(isPauseTodo({ content: "\u23F8 PAUSE" }), true, "missing U+FE0F should still match")
  assert.equal(isPauseTodo({ content: "   \t\n⏸️ checkpoint" }), true, "leading whitespace tolerant")
})

test("isPauseTodo accepts the textual fallbacks, case-sensitive (P7)", () => {
  assert.equal(isPauseTodo({ content: "PAUSE — checkpoint" }), true)
  assert.equal(isPauseTodo({ content: "  PAUSE — checkpoint" }), true)
  assert.equal(isPauseTodo({ content: "[PAUSE]" }), true)
  assert.equal(isPauseTodo({ content: "[PAUSE] handoff checkpoint" }), true)
  // must NOT false-positive on the word "Pause" mid-sentence
  assert.equal(isPauseTodo({ content: "Pause the video autoplay setting" }), false)
})

test("isPauseTodo does NOT match markers on later lines of multi-line todos (R4)", () => {
  assert.equal(
    isPauseTodo({ content: "Fix the player\nPAUSE handling in audio.ts" }),
    false,
    "PAUSE at the start of a later line must not match",
  )
  assert.equal(
    isPauseTodo({ content: "Refactor timers\n[PAUSE] state cleanup" }),
    false,
    "[PAUSE] at the start of a later line must not match",
  )
})

test("isPauseTodo handles missing/empty input", () => {
  assert.equal(isPauseTodo({ content: "Write tests" }), false)
  assert.equal(isPauseTodo(null), false)
  assert.equal(isPauseTodo(undefined), false)
  assert.equal(isPauseTodo({}), false)
})

test("countRemaining treats cancelled as not-remaining (P6)", () => {
  const todos = [
    { status: "completed", content: "a" },
    { status: "cancelled", content: "b" },
    { status: "in_progress", content: "c" },
    { status: "pending", content: "⏸️ PAUSE" },
  ]
  assert.equal(countRemaining(todos), 1, "completed+cancelled excluded; pause excluded; in_progress counts")
})

test("countRemaining reaches zero when all are completed or cancelled", () => {
  const todos = [
    { status: "completed", content: "a" },
    { status: "cancelled", content: "b" },
    { status: "completed", content: "⏸️ PAUSE" },
  ]
  assert.equal(countRemaining(todos), 0)
})

test("countRemaining reaches zero even when the pause todo was dropped from the list (R2)", () => {
  const todos = [
    { status: "completed", content: "a" },
    { status: "completed", content: "b" },
  ]
  assert.equal(countRemaining(todos), 0)
})

test("isConfirmation is case- and whitespace-insensitive", () => {
  assert.equal(isConfirmation("  Continue ", ["continue", "ok"]), true)
  assert.equal(isConfirmation("no", ["continue", "ok"]), false)
})

test("isConfirmation rejects empty string when not in list", () => {
  assert.equal(isConfirmation("", ["continue", "ok"]), false)
  assert.equal(isConfirmation(" ", ["continue", "ok"]), false)
})

test("parseExecutorModel splits on the FIRST slash (multi-segment model IDs)", () => {
  assert.deepEqual(parseExecutorModel("openrouter/deepseek/deepseek-chat"), {
    providerID: "openrouter",
    modelID: "deepseek/deepseek-chat",
  })
  assert.deepEqual(parseExecutorModel("anthropic/claude-opus-4-8"), {
    providerID: "anthropic",
    modelID: "claude-opus-4-8",
  })
  assert.equal(parseExecutorModel(""), undefined)
  assert.equal(parseExecutorModel("   "), undefined)
  assert.equal(parseExecutorModel("noprovider/"), undefined)
  assert.equal(parseExecutorModel("/nomodel"), undefined)
})