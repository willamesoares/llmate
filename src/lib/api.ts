export type Provider = string

export const LABELS: Record<string, string> = {
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  cloudflare: "Cloudflare",
  cohere: "Cohere",
  nvidia: "NVIDIA",
}

// When each provider's daily free quota resets, where it is documented.
const DAILY_RESET: Record<string, string> = {
  gemini: "at midnight Pacific time",
  cloudflare: "at midnight UTC",
}
export const label = (p?: string) => (p && LABELS[p]) || p || "The model"

const TOKEN_KEY = "llmate.token"
const PROVIDER_KEY = "llmate.provider"
const EFFORT_KEY = "llmate.effort." // + provider

export type EffortOption = { value: string; label: string; hint: string }

// Effort levels per provider, matching EFFORTS in the function. Gemini 3.x
// takes a thinking level; Groq's gpt-oss takes a reasoning effort.
export const EFFORTS: Record<string, { default: string; options: EffortOption[] }> = {
  gemini: {
    default: "minimal",
    options: [
      { value: "minimal", label: "Minimal", hint: "Answers almost right away with little or no thinking. Fastest, and Gemini's default." },
      { value: "low", label: "Low", hint: "A quick think first. Good for everyday questions." },
      { value: "medium", label: "Medium", hint: "Works through the problem. Better for multi-step questions, a bit slower." },
      { value: "high", label: "High", hint: "Thinks the longest. Best for tricky code, math or logic. Slowest." },
    ],
  },
  groq: {
    default: "medium",
    options: [
      { value: "low", label: "Low", hint: "Brief reasoning. Fastest replies, fine for simple questions." },
      { value: "medium", label: "Medium", hint: "Balanced reasoning for most questions. The model's usual setting." },
      { value: "high", label: "High", hint: "Long, careful reasoning for hard problems. Slower, and uses more of the daily token quota." },
    ],
  },
}
export const effortLabel = (provider: string, value?: string) =>
  EFFORTS[provider]?.options.find((o) => o.value === value)?.label || value || ""

const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }
const del = (k: string) => { try { localStorage.removeItem(k) } catch { /* private mode */ } }

export const store = {
  token: () => get(TOKEN_KEY),
  setToken: (v: string) => set(TOKEN_KEY, v),
  clearToken: () => del(TOKEN_KEY),
  provider: () => get(PROVIDER_KEY),
  setProvider: (v: string) => set(PROVIDER_KEY, v),
  // Remembered per provider, since each takes different levels.
  effort: (p: string) => {
    const e = EFFORTS[p]
    if (!e) return ""
    const saved = get(EFFORT_KEY + p)
    return saved && e.options.some((o) => o.value === saved) ? saved : e.default
  },
  setEffort: (p: string, v: string) => set(EFFORT_KEY + p, v),
}

export async function verify(token: string): Promise<{ status: number; providers: string[] }> {
  const res = await fetch("/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: "{}",
  })
  let data: { providers?: string[] } = {}
  try { data = await res.json() } catch { /* empty body */ }
  return { status: res.status, providers: data.providers || [] }
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

// A friendly note for quota limits instead of the raw provider error.
export function quotaMessage(
  data: { provider?: string; quota?: { kind?: string; retryAfterSeconds?: number } },
  providers: string[],
) {
  const name = (data.provider && LABELS[data.provider]) || "This provider"
  const others = providers.filter((p) => p !== data.provider)
  const alt = others.length ? " Meanwhile, you can switch to " + label(others[0]) + "." : ""
  const q = data.quota || {}
  if (q.kind === "monthly") {
    return "📅 " + name + " has used up this month's free quota. It resets next month." + alt
  }
  if (q.kind === "daily") {
    const when = waitText(q.retryAfterSeconds) || (data.provider && DAILY_RESET[data.provider]) || "soon"
    return "☕ " + name + " has used up today's free quota. Thanks for all the chatting! It resets " + when + "." + alt
  }
  const when = waitText(q.retryAfterSeconds) || "in a minute"
  return "⏳ " + name + " needs a short breather (free-tier rate limit). Try again " + when + "." + alt
}
