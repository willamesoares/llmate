// Single Netlify Function behind /api/verify, /api/chat and /api/chats/*.
// Every request must carry "Authorization: Bearer <ACCESS_TOKEN>".
import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

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

// Abort if the provider sends nothing (headers or stream data) for this long.
function idleTimer() {
  const ctrl = new AbortController();
  let t;
  const poke = () => {
    clearTimeout(t);
    t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  };
  poke();
  return { signal: ctrl.signal, poke, stop: () => clearTimeout(t), abort: () => (clearTimeout(t), ctrl.abort()) };
}

// Yield the JSON payload of each "data:" line in a server-sent-events stream.
async function* sseEvents(body, poke) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    poke();
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      yield JSON.parse(data);
    }
  }
}

// Turn a failed upstream response into an error that says why (e.g. a retired model).
async function upstreamError(name, res) {
  let body = "";
  let detail = "";
  try {
    body = await res.text();
    try {
      const j = JSON.parse(body);
      // OpenAI style {error:{message}}, Cohere {message}, Cloudflare {errors:[{message}]}.
      detail = (typeof j?.error === "string" ? j.error : j?.error?.message) || j?.message || j?.errors?.[0]?.message || j?.detail || body;
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
// Groq says "requests per day (RPD)" or "tokens per day (TPD)"; OpenRouter
// "free-models-per-day"; Cloudflare "daily free allocation". Cohere trial keys
// have a monthly cap.
export function classifyQuota(body, retryAfter) {
  const text = String(body || "");
  const monthly = /per[ -]?month|monthly|\/ ?month|a month/i.test(text);
  const daily = /per[ -]?day|\bRPD\b|\bTPD\b|daily/i.test(text);
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
  return { kind: monthly ? "monthly" : daily ? "daily" : "rate", retryAfterSeconds: seconds === null ? null : Math.ceil(seconds) };
}

// Each provider opens a streaming request. A failed request throws (so quota
// errors become a normal JSON 429); a successful one returns an async
// iterator of text pieces.
async function openGemini(messages, system, env, timer, effort) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const body = {
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (effort) {
    // Ask for thought summaries too (they are dropped below) so the stream
    // keeps moving while the model thinks and the idle timer doesn't fire.
    body.generationConfig = {
      thinkingConfig: { thinkingLevel: effort, ...(effort !== "minimal" && { includeThoughts: true }) },
    };
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: timer.signal,
    },
  );
  if (!res.ok) throw await upstreamError("Gemini", res);
  async function* pieces() {
    for await (const ev of sseEvents(res.body, timer.poke)) {
      if (ev.error) throw new Error("Gemini: " + (ev.error.message || "stream error"));
      for (const part of ev.candidates?.[0]?.content?.parts || []) {
        if (part.text && !part.thought) yield part.text;
      }
    }
  }
  return { model, pieces: pieces() };
}

// Groq, OpenRouter, Cloudflare Workers AI, Cohere and NVIDIA all
// speak the OpenAI chat-completions streaming format, so one opener serves them.
function openAICompatible(label, url, keyVar, modelVar, defaultModel, { effortParam } = {}) {
  return async function open(messages, system, env, timer, effort) {
    const model = env[modelVar] || defaultModel;
    const res = await fetch(typeof url === "function" ? url(env) : url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env[keyVar]}` },
      body: JSON.stringify({
        model,
        stream: true,
        // Reasoning models stream their thinking in a separate field (ignored
        // below); it keeps the idle timer alive while the model thinks.
        ...(effort && effortParam && { [effortParam]: effort }),
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      }),
      signal: timer.signal,
    });
    if (!res.ok) throw await upstreamError(label, res);
    async function* pieces() {
      for await (const ev of sseEvents(res.body, timer.poke)) {
        if (ev.error) throw new Error(`${label}: ` + (ev.error.message || "stream error"));
        const text = ev.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text) yield text;
      }
    }
    return { model, pieces: pieces() };
  };
}

const openGroq = openAICompatible(
  "Groq", "https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY", "GROQ_MODEL", "openai/gpt-oss-120b",
  { effortParam: "reasoning_effort" },
);
// "openrouter/free" picks one of OpenRouter's free models for each request.
const openOpenRouter = openAICompatible(
  "OpenRouter", "https://openrouter.ai/api/v1/chat/completions", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "openrouter/free",
);
const openCloudflare = openAICompatible(
  "Cloudflare",
  (env) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`,
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
);
const openCohere = openAICompatible(
  "Cohere", "https://api.cohere.ai/compatibility/v1/chat/completions", "COHERE_API_KEY", "COHERE_MODEL", "command-a-plus-05-2026",
);
const openNvidia = openAICompatible(
  "NVIDIA", "https://integrate.api.nvidia.com/v1/chat/completions", "NVIDIA_API_KEY", "NVIDIA_MODEL", "meta/llama-3.3-70b-instruct",
);

// Effort levels each provider accepts. Gemini 3.x takes a thinking level
// ("minimal" is as close to off as Flash-Lite allows); Groq's gpt-oss takes a
// reasoning effort. Leaving effort out uses the model's own default.
export const EFFORTS = {
  gemini: ["minimal", "low", "medium", "high"],
  groq: ["low", "medium", "high"],
};

// Display order. A provider is offered only when all of its env vars are set.
const PROVIDERS = {
  gemini: { keys: ["GEMINI_API_KEY"], open: openGemini },
  groq: { keys: ["GROQ_API_KEY"], open: openGroq },
  openrouter: { keys: ["OPENROUTER_API_KEY"], open: openOpenRouter },
  cloudflare: { keys: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], open: openCloudflare },
  cohere: { keys: ["COHERE_API_KEY"], open: openCohere },
  nvidia: { keys: ["NVIDIA_API_KEY"], open: openNvidia },
};

const configured = (env, name) => PROVIDERS[name].keys.every((k) => env[k]);

// Providers whose API keys are set, in display order.
export function availableProviders(env) {
  return Object.keys(PROVIDERS).filter((name) => configured(env, name));
}

// ---- Saved chats (Netlify Blobs) ----
//
// Chats live in the "chats" blob store under "<owner>/<chatId>", where owner is
// a hash of the access token. Rotating the token therefore starts a fresh,
// empty history (the old chats stay in the store, just unreachable).
// "<owner>/_index" holds the summaries the sidebar lists, so listing is one read.

const CHAT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_SAVED_MESSAGES = 1000;
const MAX_SAVED_CHARS = 2_000_000;
const MAX_TITLE = 120;
const INDEX = "_index";

export function ownerKey(token) {
  return createHash("sha256").update("llmate-chats:" + token).digest("hex").slice(0, 40);
}

export function titleFrom(messages) {
  const first = messages.find((m) => m.role === "user")?.content || "";
  const t = first.replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  return t.length > 60 ? t.slice(0, 57).trimEnd() + "…" : t;
}

function cleanTitle(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return t || null;
}

// Keep only the fields the UI shows again when a chat is reopened.
function cleanSaved(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_SAVED_MESSAGES) return null;
  const out = [];
  let chars = 0;
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    chars += m.content.length;
    const msg = { role: m.role, content: m.content };
    if (typeof m.meta === "string" && m.meta) msg.meta = m.meta.slice(0, 300);
    if (m.error === true) msg.error = true;
    if (m.notice === true) msg.notice = true;
    out.push(msg);
  }
  return chars > MAX_SAVED_CHARS ? null : out;
}

const summary = (c) => ({
  id: c.id,
  title: c.title,
  provider: c.provider,
  effort: c.effort,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});
const byRecent = (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "");

async function readIndex(store, owner) {
  const idx = await store.get(`${owner}/${INDEX}`, { type: "json" });
  return Array.isArray(idx) ? idx : [];
}
const writeIndex = (store, owner, list) => store.setJSON(`${owner}/${INDEX}`, list.sort(byRecent));

async function handleChats(action, payload, store, owner, now) {
  const id = payload?.id;
  if (action !== "list" && (typeof id !== "string" || !CHAT_ID.test(id))) {
    return json(400, { error: "id must be 8-64 letters, digits, _ or -" });
  }
  const key = `${owner}/${id}`;

  if (action === "list") {
    let index = await readIndex(store, owner);
    // Repair the index if two devices raced: drop entries whose chat is gone,
    // and pick up chats the index missed.
    const { blobs } = await store.list({ prefix: owner + "/" });
    const keys = new Set(blobs.map((b) => b.key.slice(owner.length + 1)).filter((k) => k !== INDEX));
    const listed = new Set(index.map((c) => c.id));
    let changed = false;
    if (index.some((c) => !keys.has(c.id))) {
      index = index.filter((c) => keys.has(c.id));
      changed = true;
    }
    for (const k of keys) {
      if (listed.has(k)) continue;
      const chat = await store.get(`${owner}/${k}`, { type: "json" });
      if (chat?.id) index.push(summary(chat));
      changed = true;
    }
    if (changed) await writeIndex(store, owner, index);
    return json(200, { chats: index.sort(byRecent) });
  }

  if (action === "get") {
    const chat = await store.get(key, { type: "json" });
    return chat ? json(200, { chat }) : json(404, { error: "Chat not found" });
  }

  if (action === "save") {
    const messages = cleanSaved(payload?.messages);
    if (!messages) {
      return json(400, { error: `messages must be at most ${MAX_SAVED_MESSAGES} user/assistant turns and ${MAX_SAVED_CHARS} characters` });
    }
    const provider = Object.hasOwn(PROVIDERS, payload?.provider) ? payload.provider : null;
    const effort = provider && EFFORTS[provider]?.includes(payload?.effort) ? payload.effort : null;
    const existing = await store.get(key, { type: "json" });
    const chat = {
      id,
      // Saving never renames: the title comes from the first message, or a rename.
      title: existing?.title || cleanTitle(payload?.title) || titleFrom(messages),
      provider,
      effort,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      messages,
    };
    await store.setJSON(key, chat);
    const index = (await readIndex(store, owner)).filter((c) => c.id !== id);
    index.push(summary(chat));
    await writeIndex(store, owner, index);
    return json(200, { chat: summary(chat) });
  }

  if (action === "rename") {
    const title = cleanTitle(payload?.title);
    if (!title) return json(400, { error: "title must not be empty" });
    const chat = await store.get(key, { type: "json" });
    if (!chat) return json(404, { error: "Chat not found" });
    chat.title = title;
    await store.setJSON(key, chat);
    const index = (await readIndex(store, owner)).filter((c) => c.id !== id);
    index.push(summary(chat));
    await writeIndex(store, owner, index);
    return json(200, { chat: summary(chat) });
  }

  if (action === "delete") {
    await store.delete(key);
    const index = await readIndex(store, owner);
    if (index.some((c) => c.id === id)) await writeIndex(store, owner, index.filter((c) => c.id !== id));
    return json(200, { ok: true });
  }

  return json(404, { error: "Not found" });
}

// Strong consistency so a chat saved on one device lists right away on another.
const defaultStore = () => getStore({ name: "chats", consistency: "strong" });

export async function handle(req, env, { store = defaultStore, now = () => new Date().toISOString() } = {}) {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!env.ACCESS_TOKEN) return json(500, { error: "Server is missing ACCESS_TOKEN" });
  const token = bearer(req);
  if (!tokenMatches(token, env.ACCESS_TOKEN)) return json(401, { error: "Invalid token" });

  const path = new URL(req.url).pathname;
  if (path.endsWith("/verify")) return json(200, { ok: true, providers: availableProviders(env) });
  const chats = path.match(/\/api\/chats\/(list|get|save|rename|delete)$/);
  if (!chats && !path.endsWith("/chat")) return json(404, { error: "Not found" });

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Body must be JSON" });
  }

  if (chats) {
    try {
      return await handleChats(chats[1], payload, store(), ownerKey(token), now());
    } catch (err) {
      console.error("Chat storage failed:", err.message);
      return json(503, { error: "Chat storage is unavailable: " + err.message });
    }
  }
  const messages = cleanMessages(payload?.messages);
  if (!messages) return json(400, { error: "messages must end with a user message" });

  // The client picks the provider. There is no automatic fallback.
  const name = payload?.provider;
  if (!Object.hasOwn(PROVIDERS, name)) {
    return json(400, { error: "provider must be one of: " + Object.keys(PROVIDERS).join(", ") });
  }
  if (!configured(env, name)) return json(400, { error: `${name} is not configured on the server` });
  const effort = payload?.effort ?? null;
  if (effort !== null && !(EFFORTS[name] || []).includes(effort)) {
    if (!EFFORTS[name]) return json(400, { error: `${name} does not take an effort level` });
    return json(400, { error: `effort for ${name} must be one of: ` + EFFORTS[name].join(", ") });
  }

  const timer = idleTimer();
  let opened;
  try {
    opened = await PROVIDERS[name].open(messages, env.SYSTEM_PROMPT || "", env, timer, effort);
  } catch (err) {
    timer.stop();
    const reason = err.name === "AbortError" ? `${name}: timeout` : err.message;
    console.error("Provider failed:", reason);
    if (err.quota) return json(429, { error: reason, provider: name, quota: err.quota });
    return json(502, { error: reason });
  }

  // Stream newline-delimited JSON events to the browser:
  // {type:"meta",provider,model[,effort]} then {type:"delta",text}... then {type:"done"} or {type:"error",error}.
  const enc = new TextEncoder();
  const line = (obj) => enc.encode(JSON.stringify(obj) + "\n");
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(line({ type: "meta", provider: name, model: opened.model, ...(effort && { effort }) }));
      let any = false;
      try {
        for await (const text of opened.pieces) {
          any = true;
          controller.enqueue(line({ type: "delta", text }));
        }
        if (!any) throw new Error(`${name} returned no text`);
        controller.enqueue(line({ type: "done" }));
      } catch (err) {
        const reason = err.name === "AbortError" ? `${name}: timeout` : err.message;
        console.error("Provider stream failed:", reason);
        controller.enqueue(line({ type: "error", error: reason }));
      } finally {
        timer.stop();
        controller.close();
      }
    },
    cancel() {
      timer.abort(); // the browser went away: stop the upstream request too
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default (req) => handle(req, process.env);

export const config = {
  path: ["/api/verify", "/api/chat", "/api/chats/list", "/api/chats/get", "/api/chats/save", "/api/chats/rename", "/api/chats/delete"],
};
