// Pure helpers for the prewalk plugin.
//
// NOTE ON LOCATION: this file must stay in a subdirectory of `.opencode/plugin/`.
// OpenCode auto-loads every top-level `*.{ts,js}` file in `.opencode/plugin(s)/`
// as a plugin module and treats every export as a plugin function — a module
// exporting plain constants/functions would fail that load (or worse, get its
// functions invoked with PluginInput). The discovery glob does not recurse, so
// `lib/` is safe.

export const AGENT_FRONTIER = "prewalk-frontier"
export const AGENT_EXECUTOR = "prewalk-executor"

export function isPauseTodo(t: { content?: string } | null | undefined): boolean {
  const c = (t?.content ?? "").replace(/\uFE0F/g, "").trimStart()
  // \u23F8 = "⏸"; the variation selector U+FE0F is stripped above either way.
  if (c.startsWith("\u23F8")) return true
  // Case-SENSITIVE textual fallback, anchored to the very start of the content
  // (no `m` flag: with it, `^` would match every line and a multi-line todo
  // like "Fix the player\nPAUSE handling" would false-positive).
  // Accept "[PAUSE]", "PAUSE ...", "[PAUSE] ..." — not "Pause ...".
  return /^\[?PAUSE\b/.test(c)
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
  if (i <= 0 || i === s.length - 1) return undefined
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

export function isConfirmation(text: string, confirmations: string[]): boolean {
  const t = text.trim().toLowerCase()
  return confirmations.some((c) => c.trim().toLowerCase() === t)
}