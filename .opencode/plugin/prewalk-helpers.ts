export const AGENT_FRONTIER = "prewalk-frontier"
export const AGENT_EXECUTOR = "prewalk-executor"
export const PAUSE_MARKER = "⏸️"

export function isPauseTodo(t: { content?: string } | null | undefined): boolean {
  const c = (t?.content ?? "").replace(/\uFE0F/g, "").trimStart()
  // \u23F8 = "⏸"; the variation selector U+FE0F is stripped above either way.
  if (c.startsWith("\u23F8")) return true
  // Case-SENSITIVE textual fallback to avoid false positives on the word "Pause"
  // mid-sentence. Accept "[PAUSE]", "PAUSE ...", "[PAUSE] ..." — not "Pause ...".
  return /^\[?PAUSE\b/m.test(c)
}

export function countRemaining<T extends { status?: string; content?: string }>(todos: T[]): number {
  return todos.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled" && !isPauseTodo(t),
  ).length
}

export function parseExecutorModel(
  raw: string,
): { providerID: string; modelID: string } | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const i = s.indexOf("/")
  if (i < 0) return undefined
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

export function isConfirmation(text: string, confirmations: string[]): boolean {
  const t = text.trim().toLowerCase()
  return confirmations.some((c) => c.trim().toLowerCase() === t)
}
