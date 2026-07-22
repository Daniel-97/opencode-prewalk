import { test } from "node:test"
import assert from "node:assert/strict"
import { isPauseTodo, countRemaining, isConfirmation, parseExecutorModel } from "./prewalk-helpers"

test("isPauseTodo matches current behavior (red before P6/P7 hardening)", () => {
  assert.equal(isPauseTodo({ content: "⏸️ PAUSE — handoff" }), true)
  // P7: emoji without variation selector should ALSO match
  assert.equal(isPauseTodo({ content: "\u23F8 PAUSE" }), true, "missing U+FE0F should still match")
  // P7: textual variants
  assert.equal(isPauseTodo({ content: "  PAUSE — checkpoint" }), true)
  assert.equal(isPauseTodo({ content: "[PAUSE]" }), true)
  // P7: must NOT false-positive on the word "Pause" mid-sentence (case-sensitive fallback)
  assert.equal(isPauseTodo({ content: "Pause the video autoplay setting" }), false)
  // P7: leading whitespace tolerant
  assert.equal(isPauseTodo({ content: "   \t\n⏸️ checkpoint" }), true)
  // P6: cancelled is NOT counted as remaining -> but for isPauseTodo it's about pause
  assert.equal(isPauseTodo({ content: "Write tests" }), false)
  assert.equal(isPauseTodo(null), false)
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

test("isConfirmation is case- and whitespace-insensitive", () => {
  assert.equal(isConfirmation("  Continue ", ["continue", "ok"]), true)
  assert.equal(isConfirmation("no", ["continue", "ok"]), false)
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
  assert.deepEqual(parseExecutorModel("noprovider/"), { providerID: "noprovider", modelID: "" })
})
