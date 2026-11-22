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
      // OpenAI style {error:{message}}, plain {message}, Cloudflare {errors:[{message}]}.
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
// Groq says "requests per day (RPD)" or "tokens per day (TPD)"; Cloudflare
// "daily free allocation".
export function classifyQuota(body, retryAfter) {
  const text = String(body || "");
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
  return { kind: daily ? "daily" : "rate", retryAfterSeconds: seconds === null ? null : Math.ceil(seconds) };
}

// Each provider opens a streaming request. A failed request throws (so quota
// errors become a normal JSON 429); a successful one returns an async
// iterator of text pieces.
async function openGemini(model, messages, system, env, timer, effort) {
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

// Some open models (DeepSeek R1 distills, Qwen) write their reasoning into the
// reply itself, wrapped in <think>...</think>. Drop a leading think block so
// only the answer is shown, the same as for models that stream it separately.
export function thinkStripper() {
  let state = "start"; // start -> (thinking ->) answer
  let buf = "";
  return (text) => {
    if (state === "answer") return text;
    buf += text;
    if (state === "start") {
      const lead = buf.trimStart();
      if (!lead) return "";
      if ("<think>".startsWith(lead)) return ""; // could still be the opening tag
      if (!lead.startsWith("<think>")) {
        state = "answer";
        const out = buf;
        buf = "";
        return out;
      }
      state = "thinking";
    }
    const end = buf.indexOf("</think>");
    if (end < 0) {
      buf = buf.slice(-8); // keep enough to catch a tag split across chunks
      return "";
    }
    state = "answer";
    const out = buf.slice(end + 8).trimStart();
    buf = "";
    return out;
  };
}

// Groq and Cloudflare Workers AI speak the OpenAI chat-completions streaming
// format, so one opener serves both.
function openAICompatible(label, url, keyVar) {
  return async function open(model, messages, system, env, timer, effort, extra) {
    const res = await fetch(typeof url === "function" ? url(env) : url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env[keyVar]}` },
      body: JSON.stringify({
        model,
        stream: true,
        ...extra,
        // Reasoning models stream their thinking in a separate field (ignored
        // below); it keeps the idle timer alive while the model thinks.
        ...(effort && { reasoning_effort: effort }),
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      }),
      signal: timer.signal,
    });
    if (!res.ok) throw await upstreamError(label, res);
    async function* pieces() {
      const strip = thinkStripper();
      for await (const ev of sseEvents(res.body, timer.poke)) {
        if (ev.error) throw new Error(`${label}: ` + (ev.error.message || "stream error"));
        const raw = ev.choices?.[0]?.delta?.content;
        const text = typeof raw === "string" && raw ? strip(raw) : "";
        if (text) yield text;
      }
    }
    return { model, pieces: pieces() };
  };
}

const openGroq = openAICompatible("Groq", "https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY");
const openCloudflare = openAICompatible(
  "Cloudflare",
  (env) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`,
  "CLOUDFLARE_API_TOKEN",
);

// Display order. A provider is offered only when all of its env vars are set.
const PROVIDERS = {
  gemini: { keys: ["GEMINI_API_KEY"], open: openGemini },
  groq: { keys: ["GROQ_API_KEY"], open: openGroq },
  cloudflare: { keys: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], open: openCloudflare },
};

// The models offered for each provider, all on its free tier (as of November
// 2026). The first one is the provider's default. "effort" lists the levels a
// model takes and the one picked by default; models without it get none.
// Gemini 3.x takes a thinking level; the others take a reasoning effort.
const GEMINI_LEVELS = ["minimal", "low", "medium", "high"];
const GPT_OSS = { levels: ["low", "medium", "high"], default: "medium" };
export const MODELS = {
  gemini: [
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", effort: { levels: GEMINI_LEVELS, default: "minimal" } },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", effort: { levels: GEMINI_LEVELS, default: "high" } },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  ],
  groq: [
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", effort: GPT_OSS },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", effort: GPT_OSS },
    // Groq returns Qwen's reasoning inside the reply unless told to hide it.
    { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B (preview)", extra: { reasoning_format: "hidden" } },
  ],
  cloudflare: [
    { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" },
    { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
    { id: "@cf/meta/llama-3.1-8b-instruct-fp8-fast", label: "Llama 3.1 8B" },
    { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", effort: GPT_OSS },
    { id: "@cf/openai/gpt-oss-20b", label: "GPT-OSS 20B", effort: GPT_OSS },
    { id: "@cf/qwen/qwen3.8-27b", label: "Qwen 3.8 27B", effort: { levels: ["low", "medium", "xhigh"], default: "low" } },
    { id: "@cf/qwen/qwen3-30b-a3b-fp8", label: "Qwen3 30B" },
    { id: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B" },
    { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", label: "DeepSeek R1 Distill 32B" },
    { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B" },
    { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B" },
    { id: "@cf/zai-org/glm-4.7-flash", label: "GLM 4.7 Flash" },
    { id: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 3 120B" },
    { id: "@cf/ibm-granite/granite-4.0-h-micro", label: "Granite 4.0 Micro" },
    { id: "@cf/aisingapore/gemma-sea-lion-v4-27b-it", label: "SEA-LION v4 27B" },
  ],
};

export const findModel = (provider, id) =>
  Object.hasOwn(MODELS, provider) ? MODELS[provider].find((m) => m.id === id) || null : null;

const configured = (env, name) => PROVIDERS[name].keys.every((k) => env[k]);

// Providers whose API keys are set, in display order.
export function availableProviders(env) {
  return Object.keys(PROVIDERS).filter((name) => configured(env, name));
}

// What the model picker shows: every model of every configured provider.
export function availableModels(env) {
  return availableProviders(env).flatMap((provider) =>
    MODELS[provider].map(({ id, label, effort }) => ({ provider, id, label, ...(effort && { effort }) })),
  );
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
  model: c.model,
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
    const model = findModel(provider, payload?.model);
    const effort = model?.effort?.levels.includes(payload?.effort) ? payload.effort : null;
    const existing = await store.get(key, { type: "json" });
    const chat = {
      id,
      // Saving never renames: the title comes from the first message, or a rename.
      title: existing?.title || cleanTitle(payload?.title) || titleFrom(messages),
      provider,
      model: model?.id || null,
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
  if (path.endsWith("/verify")) return json(200, { ok: true, providers: availableProviders(env), models: availableModels(env) });
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
  // Leaving the model out picks the provider's default (older clients send none).
  const model = payload?.model == null ? MODELS[name][0] : findModel(name, payload.model);
  if (!model) {
    return json(400, { error: `model for ${name} must be one of: ` + MODELS[name].map((m) => m.id).join(", ") });
  }
  const effort = payload?.effort ?? null;
  if (effort !== null && !model.effort?.levels.includes(effort)) {
    if (!model.effort) return json(400, { error: `${model.id} does not take an effort level` });
    return json(400, { error: `effort for ${model.id} must be one of: ` + model.effort.levels.join(", ") });
  }

  const timer = idleTimer();
  let opened;
  try {
    opened = await PROVIDERS[name].open(model.id, messages, env.SYSTEM_PROMPT || "", env, timer, effort, model.extra);
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
