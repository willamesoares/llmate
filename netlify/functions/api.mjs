// Single Netlify Function behind /api/verify and /api/chat.
// Every request must carry "Authorization: Bearer <ACCESS_TOKEN>".
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_MESSAGES = 40; // history turns sent upstream
const MAX_CHARS = 32_000; // total characters across the history
const UPSTREAM_TIMEOUT_MS = 20_000;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Hash both sides so the compare is constant-time regardless of length.
export function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected.length < 16) {
    return false;
  }
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

function cleanMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-MAX_MESSAGES);
  // Drop the oldest turns until the history fits the size cap.
  while (msgs.length > 1 && msgs.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) msgs.shift();
  if (msgs.length === 0 || msgs[msgs.length - 1].role !== "user") return null;
  if (msgs[0].content.length > MAX_CHARS) return null;
  return msgs;
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Turn a failed upstream response into an error that says why (e.g. a retired model).
async function upstreamError(name, res) {
  let body = "";
  let detail = "";
  try {
    body = await res.text();
    try {
      detail = JSON.parse(body)?.error?.message || body;
    } catch {
      detail = body;
    }
  } catch {}
  detail = String(detail).replace(/\s+/g, " ").trim().slice(0, 300);
  const err = new Error(`${name} HTTP ${res.status}${detail ? ": " + detail : ""}`);
  if (res.status === 429) err.quota = classifyQuota(body, res.headers.get("retry-after"));
  return err;
}

// Work out from a 429 whether a daily quota or a short rate limit was hit,
// and roughly when to retry. Gemini names the quota (e.g. "...PerDay...");
// Groq says "requests per day (RPD)" or "tokens per day (TPD)".
export function classifyQuota(body, retryAfter) {
  const text = String(body || "");
  const daily = /per ?day|\bRPD\b|\bTPD\b|daily/i.test(text);
  let seconds = null;
  const m = text.match(/(?:retry|try again) in ((?:[\d.]+[hms])+)/i);
  if (m) {
    seconds = 0;
    for (const [, n, unit] of m[1].matchAll(/([\d.]+)([hms])/g)) {
      seconds += parseFloat(n) * { h: 3600, m: 60, s: 1 }[unit];
    }
  } else if (retryAfter && /^\d+$/.test(retryAfter)) {
    seconds = Number(retryAfter);
  }
  return { kind: daily ? "daily" : "rate", retryAfterSeconds: seconds === null ? null : Math.ceil(seconds) };
}

async function callGemini(messages, system, env) {
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const body = {
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await upstreamError("Gemini", res);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned no text");
  return { text, provider: "gemini", model };
}

async function callGroq(messages, system, env) {
  const model = env.GROQ_MODEL || "openai/gpt-oss-120b";
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    }),
  });
  if (!res.ok) throw await upstreamError("Groq", res);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Groq returned no text");
  return { text, provider: "groq", model };
}

const PROVIDERS = {
  gemini: { key: "GEMINI_API_KEY", call: callGemini },
  groq: { key: "GROQ_API_KEY", call: callGroq },
};

// Providers whose API key is set, in display order.
export function availableProviders(env) {
  return Object.keys(PROVIDERS).filter((name) => env[PROVIDERS[name].key]);
}

export async function handle(req, env) {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!env.ACCESS_TOKEN) return json(500, { error: "Server is missing ACCESS_TOKEN" });
  if (!tokenMatches(bearer(req), env.ACCESS_TOKEN)) return json(401, { error: "Invalid token" });

  const path = new URL(req.url).pathname;
  if (path.endsWith("/verify")) return json(200, { ok: true, providers: availableProviders(env) });
  if (!path.endsWith("/chat")) return json(404, { error: "Not found" });

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Body must be JSON" });
  }
  const messages = cleanMessages(payload?.messages);
  if (!messages) return json(400, { error: "messages must end with a user message" });

  // The client picks the provider. There is no automatic fallback.
  const name = payload?.provider;
  if (!Object.hasOwn(PROVIDERS, name)) {
    return json(400, { error: "provider must be one of: " + Object.keys(PROVIDERS).join(", ") });
  }
  if (!env[PROVIDERS[name].key]) return json(400, { error: `${name} is not configured on the server` });

  try {
    return json(200, await PROVIDERS[name].call(messages, env.SYSTEM_PROMPT || "", env));
  } catch (err) {
    const reason = err.name === "AbortError" ? `${name}: timeout` : err.message;
    console.error("Provider failed:", reason);
    if (err.quota) return json(429, { error: reason, provider: name, quota: err.quota });
    return json(502, { error: reason });
  }
}

export default (req) => handle(req, process.env);

export const config = { path: ["/api/verify", "/api/chat"] };
