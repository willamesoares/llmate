export type Provider = string

export const LABELS: Record<string, string> = { gemini: "Gemini", groq: "Groq", cloudflare: "Cloudflare" }
export const label = (p?: string) => (p && LABELS[p]) || p || "The model"

// One entry of the server's model catalog (only providers with keys are sent).
export type Model = {
  provider: string
  id: string
  label: string
  effort?: { levels: string[]; default: string }
}
export const modelKey = (m: { provider: string; id: string }) => m.provider + ":" + m.id
export const findModel = (models: Model[], provider?: string | null, id?: string | null) =>
  models.find((m) => m.provider === provider && m.id === id)

const TOKEN_KEY = "llmate.token"
const MODEL_KEY = "llmate.model" // provider:model
const EFFORT_KEY = "llmate.effort." // + provider:model

export type EffortOption = { value: string; label: string; hint: string }

// What each effort level means, shown in the effort menu. Gemini 3.x calls it
// a thinking level; the others a reasoning effort. Same idea either way.
const EFFORT_TEXT: Record<string, { label: string; hint: string }> = {
  minimal: { label: "Minimal", hint: "Answers almost right away with little or no thinking. Fastest." },
  low: { label: "Low", hint: "A quick think first. Good for everyday questions." },
  medium: { label: "Medium", hint: "Works through the problem. Better for multi-step questions, a bit slower." },
  high: { label: "High", hint: "Thinks the longest. Best for tricky code, math or logic. Slowest, and uses more of the free quota." },
  xhigh: { label: "Max", hint: "Reasons at length before answering. Slowest, and uses the most of the daily allowance." },
}
export const effortOptions = (m?: Model): EffortOption[] =>
  (m?.effort?.levels || []).map((v) => ({ value: v, ...(EFFORT_TEXT[v] || { label: v, hint: "" }) }))
export const effortLabel = (value?: string) => (value && EFFORT_TEXT[value]?.label) || value || ""

const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }
const del = (k: string) => { try { localStorage.removeItem(k) } catch { /* private mode */ } }

export const store = {
  token: () => get(TOKEN_KEY),
  setToken: (v: string) => set(TOKEN_KEY, v),
  clearToken: () => del(TOKEN_KEY),
  model: () => get(MODEL_KEY),
  setModel: (m: Model) => set(MODEL_KEY, modelKey(m)),
  // Remembered per model, since each takes different levels.
  effort: (m?: Model) => {
    const e = m?.effort
    if (!m || !e) return ""
    const saved = get(EFFORT_KEY + modelKey(m))
    return saved && e.levels.includes(saved) ? saved : e.default
  },
  setEffort: (m: Model, v: string) => set(EFFORT_KEY + modelKey(m), v),
}

export async function verify(token: string): Promise<{ status: number; models: Model[] }> {
  const res = await fetch("/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: "{}",
  })
  let data: { models?: Model[] } = {}
  try { data = await res.json() } catch { /* empty body */ }
  return { status: res.status, models: data.models || [] }
}

export type StreamEvent =
  | { type: "meta"; provider: string; model: string; effort?: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; error: string }

// Reads the function's newline-delimited JSON events.
export async function readStream(res: Response, onEvent: (ev: StreamEvent) => void) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onEvent(JSON.parse(line))
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf))
}

function waitText(sec?: number | null) {
  if (sec == null) return ""
  if (sec < 60) return "in a few seconds"
  if (sec < 3600) return "in about " + Math.ceil(sec / 60) + " min"
  const h = Math.round(sec / 360) / 10
  return "in about " + h + (h === 1 ? " hour" : " hours")
}

// When each provider's daily free quota resets, where it is documented.
const DAILY_RESET: Record<string, string> = {
  gemini: "at midnight Pacific time",
  cloudflare: "at midnight UTC",
}

// A friendly note for quota limits instead of the raw provider error.
export function quotaMessage(
  data: { provider?: string; quota?: { kind?: string; retryAfterSeconds?: number } },
  providers: string[],
) {
  const name = (data.provider && LABELS[data.provider]) || "This provider"
  const others = providers.filter((p) => p !== data.provider)
  const alt = others.length ? " Meanwhile, you can pick a " + label(others[0]) + " model." : ""
  const q = data.quota || {}
  if (q.kind === "daily") {
    const when = waitText(q.retryAfterSeconds) || (data.provider && DAILY_RESET[data.provider]) || "soon"
    return "☕ " + name + " has used up today's free quota. Thanks for all the chatting! It resets " + when + "." + alt
  }
  const when = waitText(q.retryAfterSeconds) || "in a minute"
  return "⏳ " + name + " needs a short breather (free-tier rate limit). Try again " + when + "." + alt
}
