import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handle, tokenMatches } from "../netlify/functions/api.mjs";

const TOKEN = "test-token-0123456789abcdef";
const env = { ACCESS_TOKEN: TOKEN, GEMINI_API_KEY: "g", GROQ_API_KEY: "q" };
const realFetch = globalThis.fetch;
let calls;

const req = (path, { token = TOKEN, body, method = "POST" } = {}) =>
  new Request("https://x.netlify.app" + path, {
    method,
    headers: token ? { authorization: "Bearer " + token, "content-type": "application/json" } : {},
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });

// A server-sent-events response, delivered in awkward chunk boundaries on purpose.
const sse = (events, { tail = "" } = {}) => {
  const text = events.map((e) => "data: " + JSON.stringify(e) + "\r\n\r\n").join("") + tail;
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const gem = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
const grq = (t) => ({ choices: [{ delta: { content: t } }] });
const geminiOk = () => sse([gem("hi from "), gem("gemini")]);
const groqOk = () => sse([grq("hi from "), grq("groq"), { choices: [{ delta: {} }] }], { tail: "data: [DONE]\n\n" });

// Read the function's NDJSON stream into a list of events.
async function events(res) {
  assert.match(res.headers.get("content-type"), /ndjson/);
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}
const textOf = (evs) => evs.filter((e) => e.type === "delta").map((e) => e.text).join("");

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test("tokenMatches", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches("wrong", TOKEN), false);
  assert.equal(tokenMatches("", TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches("short", "short"), false, "refuses weak server tokens");
});

test("rejects missing and wrong tokens without calling providers", async () => {
  mockFetch(() => { throw new Error("should not be called"); });
  assert.equal((await handle(req("/api/verify", { token: null }), env)).status, 401);
  assert.equal((await handle(req("/api/chat", { token: "nope", body: { provider: "gemini", messages: [{ role: "user", content: "x" }] } }), env)).status, 401);
  assert.equal(calls.length, 0);
});

test("rejects non-POST", async () => {
  assert.equal((await handle(req("/api/verify", { method: "GET" }), env)).status, 405);
});

test("500 when ACCESS_TOKEN unset", async () => {
  assert.equal((await handle(req("/api/verify"), { ...env, ACCESS_TOKEN: "" })).status, 500);
});

test("verify succeeds and lists configured providers", async () => {
  const res = await handle(req("/api/verify"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, providers: ["gemini", "groq"] });
  const only = await handle(req("/api/verify"), { ...env, GEMINI_API_KEY: "" });
  assert.deepEqual((await only.json()).providers, ["groq"]);
});

const chat = (provider, messages = [{ role: "user", content: "x" }], extra = {}) =>
  req("/api/chat", { body: { provider, messages, ...extra } });

test("gemini: streams text, maps roles and sends system prompt", async () => {
  mockFetch(() => geminiOk());
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const res = await handle(chat("gemini", messages), { ...env, SYSTEM_PROMPT: "be nice" });
  assert.equal(res.status, 200);
  const evs = await events(res);
  assert.deepEqual(evs[0], { type: "meta", provider: "gemini", model: "gemini-3.5-flash-lite" });
  assert.equal(textOf(evs), "hi from gemini");
  assert.equal(evs.filter((e) => e.type === "delta").length, 2, "arrives in pieces");
  assert.deepEqual(evs.at(-1), { type: "done" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[0].opts.headers["x-goog-api-key"], "g");
  const sent = JSON.parse(calls[0].opts.body);
  assert.deepEqual(sent.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(sent.systemInstruction.parts[0].text, "be nice");
  assert.equal(sent.generationConfig, undefined, "no effort picked: model default");
});

test("groq: streams text and calls only Groq", async () => {
  mockFetch(() => groqOk());
  const res = await handle(chat("groq"), { ...env, SYSTEM_PROMPT: "be nice" });
  const evs = await events(res);
  assert.equal(evs[0].provider, "groq");
  assert.equal(textOf(evs), "hi from groq");
  assert.deepEqual(evs.at(-1), { type: "done" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.groq\.com/);
  assert.equal(calls[0].opts.headers.authorization, "Bearer q");
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.messages[0], { role: "system", content: "be nice" });
  assert.equal("reasoning_effort" in sent, false, "no effort picked: model default");
});

test("gemini effort becomes a thinking level, thoughts stay hidden", async () => {
  const thought = { candidates: [{ content: { parts: [{ text: "pondering", thought: true }] } }] };
  mockFetch(() => sse([thought, gem("answer")]));
  const evs = await events(await handle(chat("gemini", undefined, { effort: "high" }), env));
  assert.deepEqual(evs[0], { type: "meta", provider: "gemini", model: "gemini-3.5-flash-lite", effort: "high" });
  assert.equal(textOf(evs), "answer");
  const sent = JSON.parse(calls[0].opts.body);
  assert.deepEqual(sent.generationConfig.thinkingConfig, { thinkingLevel: "high", includeThoughts: true });

  calls = [];
  mockFetch(() => geminiOk());
  await events(await handle(chat("gemini", undefined, { effort: "minimal" }), env));
  assert.deepEqual(JSON.parse(calls[0].opts.body).generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
});

test("groq effort becomes reasoning_effort, reasoning stays hidden", async () => {
  mockFetch(() => sse([{ choices: [{ delta: { reasoning: "hmm" } }] }, grq("answer")]));
  const evs = await events(await handle(chat("groq", undefined, { effort: "low" }), env));
  assert.equal(evs[0].effort, "low");
  assert.equal(textOf(evs), "answer");
  assert.equal(JSON.parse(calls[0].opts.body).reasoning_effort, "low");
});

test("400 on an effort the provider doesn't take", async () => {
  mockFetch(() => { throw new Error("should not be called"); });
  for (const [p, effort] of [["groq", "minimal"], ["gemini", "max"], ["gemini", 3], ["groq", "toString"]]) {
    assert.equal((await handle(chat(p, undefined, { effort }), env)).status, 400, p + " " + effort);
  }
  assert.equal(calls.length, 0);
});

test("an error mid-stream ends with an error event", async () => {
  mockFetch(() => sse([grq("partial"), { error: { message: "overloaded" } }]));
  const evs = await events(await handle(chat("groq"), env));
  assert.equal(textOf(evs), "partial");
  assert.deepEqual(evs.at(-1), { type: "error", error: "Groq: overloaded" });
});

test("an empty stream is reported as an error", async () => {
  mockFetch(() => sse([]));
  const evs = await events(await handle(chat("gemini"), env));
  assert.deepEqual(evs.at(-1), { type: "error", error: "gemini returned no text" });
});

test("no fallback: a Gemini 429 is returned as a quota error", async () => {
  mockFetch(() => new Response("quota", { status: 429 }));
  const res = await handle(chat("gemini"), env);
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.match(data.error, /429/);
  assert.equal(data.provider, "gemini");
  assert.deepEqual(data.quota, { kind: "rate", retryAfterSeconds: null });
  assert.equal(calls.length, 1, "Groq must not be called");
});

test("Gemini daily quota is detected", async () => {
  const body = {
    error: {
      code: 429,
      message: "You exceeded your current quota. Please retry in 41.2s.",
      details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
    },
  };
  mockFetch(() => new Response(JSON.stringify(body), { status: 429 }));
  const data = await (await handle(chat("gemini"), env)).json();
  assert.deepEqual(data.quota, { kind: "daily", retryAfterSeconds: 42 });
});

test("Groq daily and per-minute limits are told apart", async () => {
  const daily = { error: { message: "Rate limit reached for model `x` on requests per day (RPD): Limit 1000, Used 1000. Please try again in 7m12.5s." } };
  mockFetch(() => new Response(JSON.stringify(daily), { status: 429 }));
  assert.deepEqual((await (await handle(chat("groq"), env)).json()).quota, { kind: "daily", retryAfterSeconds: 433 });
  const minute = { error: { message: "Rate limit reached on tokens per minute (TPM): Please try again in 2.5s." } };
  mockFetch(() => new Response(JSON.stringify(minute), { status: 429 }));
  assert.deepEqual((await (await handle(chat("groq"), env)).json()).quota, { kind: "rate", retryAfterSeconds: 3 });
});

test("Retry-After header is used when the body has no hint", async () => {
  mockFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
  assert.deepEqual((await (await handle(chat("groq"), env)).json()).quota, { kind: "rate", retryAfterSeconds: 30 });
});

test("upstream error message is passed through", async () => {
  mockFetch(() => new Response(JSON.stringify({ error: { code: 404, message: "models/x is not found" } }), { status: 404 }));
  const res = await handle(chat("gemini"), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "Gemini HTTP 404: models/x is not found");
});

test("no fallback: a network error is returned as an error", async () => {
  mockFetch(() => { throw new Error("ECONNRESET"); });
  const res = await handle(chat("groq"), env);
  assert.equal(res.status, 502);
  assert.equal(calls.length, 1);
});

test("400 on missing, unknown or unconfigured provider", async () => {
  mockFetch(() => { throw new Error("should not be called"); });
  for (const p of [undefined, "openai", "toString", "__proto__"]) {
    assert.equal((await handle(chat(p), env)).status, 400, String(p));
  }
  assert.equal((await handle(chat("gemini"), { ...env, GEMINI_API_KEY: "" })).status, 400);
  assert.equal(calls.length, 0);
});

test("400 on bad message payloads", async () => {
  for (const messages of [null, [], [{ role: "assistant", content: "x" }], [{ role: "system", content: "x" }]]) {
    assert.equal((await handle(chat("gemini", messages), env)).status, 400);
  }
});

// ---- Saved chats ----

// An in-memory stand-in for a Netlify Blobs store.
function memStore() {
  const data = new Map();
  return {
    data,
    async get(key, { type } = {}) {
      if (!data.has(key)) return null;
      return type === "json" ? JSON.parse(data.get(key)) : data.get(key);
    },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = "" } = {}) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: "x" })) };
    },
  };
}

function chatsApi(token = TOKEN) {
  const store = memStore();
  let tick = 0;
  const deps = { store: () => store, now: () => new Date(Date.UTC(2026, 10, 22, 0, 0, tick++)).toISOString() };
  const call = async (action, body, t = token) => {
    const res = await handle(req("/api/chats/" + action, { token: t, body }), env, deps);
    return { status: res.status, body: await res.json() };
  };
  return { store, call, deps };
}

const turns = [
  { role: "user", content: "How do   I bake\nsourdough bread at home without a fancy oven or a stand mixer?" },
  { role: "assistant", content: "Use a Dutch oven.", meta: "Groq · gpt-oss-120b" },
];

test("chats: save, list, get, rename, delete", async () => {
  const { call } = chatsApi();
  assert.deepEqual((await call("list", {})).body, { chats: [] });

  const saved = await call("save", { id: "chat_0001", provider: "groq", effort: "high", messages: turns });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.chat.title, "How do I bake sourdough bread at home without a fancy ove…");
  assert.equal(saved.body.chat.provider, "groq");
  assert.equal(saved.body.chat.effort, "high");

  await call("save", { id: "chat_0002", provider: "gemini", messages: [{ role: "user", content: "second" }] });
  const list = (await call("list", {})).body.chats;
  assert.deepEqual(list.map((c) => c.id), ["chat_0002", "chat_0001"], "most recent first");

  const got = (await call("get", { id: "chat_0001" })).body.chat;
  assert.deepEqual(got.messages, turns);

  assert.equal((await call("rename", { id: "chat_0001", title: "  Bread  " })).body.chat.title, "Bread");
  // Saving again keeps the rename and moves the chat to the top.
  await call("save", { id: "chat_0001", provider: "groq", messages: [...turns, { role: "user", content: "more" }] });
  const after = (await call("list", {})).body.chats;
  assert.equal(after[0].id, "chat_0001");
  assert.equal(after[0].title, "Bread");
  assert.equal(after[0].createdAt, saved.body.chat.createdAt);

  assert.equal((await call("delete", { id: "chat_0001" })).status, 200);
  assert.equal((await call("get", { id: "chat_0001" })).status, 404);
  assert.deepEqual((await call("list", {})).body.chats.map((c) => c.id), ["chat_0002"]);
});

test("chats: each token sees only its own chats", async () => {
  const { call } = chatsApi();
  await call("save", { id: "chat_0001", messages: turns });
  const other = "another-token-0123456789";
  const res = await handle(req("/api/chats/list", { token: other, body: {} }), { ...env, ACCESS_TOKEN: other }, chatsApi().deps);
  assert.deepEqual((await res.json()).chats, []);
});

test("chats: token is checked before storage is touched", async () => {
  const deps = { store: () => { throw new Error("should not be called"); } };
  for (const action of ["list", "get", "save", "rename", "delete"]) {
    const res = await handle(req("/api/chats/" + action, { token: "nope", body: { id: "chat_0001" } }), env, deps);
    assert.equal(res.status, 401);
  }
});

test("chats: bad input is refused", async () => {
  const { call } = chatsApi();
  assert.equal((await call("get", { id: "../x" })).status, 400);
  assert.equal((await call("save", { id: "chat_0001", messages: [{ role: "system", content: "x" }] })).status, 400);
  assert.equal((await call("save", { id: "chat_0001", messages: "nope" })).status, 400);
  assert.equal((await call("rename", { id: "chat_0001", title: "x" })).status, 404);
  await call("save", { id: "chat_0001", messages: turns });
  assert.equal((await call("rename", { id: "chat_0001", title: "   " })).status, 400);
  assert.equal((await call("nope", {})).status, 404);
});

test("chats: unknown provider or effort is dropped, not stored", async () => {
  const { call } = chatsApi();
  const c = (await call("save", { id: "chat_0001", provider: "evil", effort: "max", messages: turns })).body.chat;
  assert.equal(c.provider, null);
  assert.equal(c.effort, null);
  const d = (await call("save", { id: "chat_0002", provider: "gemini", effort: "max", messages: turns })).body.chat;
  assert.equal(d.provider, "gemini");
  assert.equal(d.effort, null);
});

test("chats: list repairs an index that missed a save or a delete", async () => {
  const { call, store } = chatsApi();
  await call("save", { id: "chat_0001", messages: turns });
  await call("save", { id: "chat_0002", messages: turns });
  const owner = [...store.data.keys()][0].split("/")[0];
  // Another device's index write was lost, and a chat blob vanished.
  store.data.set(owner + "/_index", JSON.stringify([{ id: "chat_0002", title: "t", updatedAt: "z" }, { id: "gone_0000", title: "g" }]));
  const ids = (await call("list", {})).body.chats.map((c) => c.id).sort();
  assert.deepEqual(ids, ["chat_0001", "chat_0002"]);
});

test("chats: storage failure is a 503, not a crash", async () => {
  const deps = { store: () => ({ get: async () => { throw new Error("blobs down"); } }) };
  const res = await handle(req("/api/chats/get", { body: { id: "chat_0001" } }), env, deps);
  assert.equal(res.status, 503);
});

// ---- Extra OpenAI-compatible providers ----

const extraEnv = {
  ACCESS_TOKEN: TOKEN,
  OPENROUTER_API_KEY: "or",
  CLOUDFLARE_ACCOUNT_ID: "acc123",
  CLOUDFLARE_API_TOKEN: "cf",
  COHERE_API_KEY: "co",
  NVIDIA_API_KEY: "nv",
};

test("verify lists every configured provider in order; Cloudflare needs both vars", async () => {
  const all = await (await handle(req("/api/verify"), { ...env, ...extraEnv })).json();
  assert.deepEqual(all.providers, ["gemini", "groq", "openrouter", "cloudflare", "cohere", "nvidia"]);
  const noAccount = await (await handle(req("/api/verify"), { ...extraEnv, CLOUDFLARE_ACCOUNT_ID: "" })).json();
  assert.deepEqual(noAccount.providers, ["openrouter", "cohere", "nvidia"]);
  const res = await handle(chat("cloudflare"), { ...extraEnv, CLOUDFLARE_API_TOKEN: "" });
  assert.equal(res.status, 400);
});

for (const [name, url, key, model] of [
  ["openrouter", "https://openrouter.ai/api/v1/chat/completions", "or", "openrouter/free"],
  ["cloudflare", "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions", "cf", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
  ["cohere", "https://api.cohere.ai/compatibility/v1/chat/completions", "co", "command-a-plus-05-2026"],
  ["nvidia", "https://integrate.api.nvidia.com/v1/chat/completions", "nv", "meta/llama-3.3-70b-instruct"],
]) {
  test(`${name}: streams from its endpoint with its key and default model`, async () => {
    mockFetch(() => sse([grq("hello "), grq(name)], { tail: "data: [DONE]\n\n" }));
    const evs = await events(await handle(chat(name), { ...extraEnv, SYSTEM_PROMPT: "be nice" }));
    assert.deepEqual(evs[0], { type: "meta", provider: name, model });
    assert.equal(textOf(evs), "hello " + name);
    assert.deepEqual(evs.at(-1), { type: "done" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].opts.headers.authorization, "Bearer " + key);
    const sent = JSON.parse(calls[0].opts.body);
    assert.equal(sent.model, model);
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages[0], { role: "system", content: "be nice" });
  });
}

test("a model override env var is used", async () => {
  mockFetch(() => sse([grq("ok")]));
  const evs = await events(await handle(chat("openrouter"), { ...extraEnv, OPENROUTER_MODEL: "some/model:free" }));
  assert.equal(evs[0].model, "some/model:free");
  assert.equal(JSON.parse(calls[0].opts.body).model, "some/model:free");
});

test("providers without effort levels refuse an effort", async () => {
  mockFetch(() => { throw new Error("should not be called"); });
  const res = await handle(chat("cohere", undefined, { effort: "high" }), extraEnv);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not take an effort/);
  assert.equal(calls.length, 0);
});

test("OpenRouter, Cloudflare and Cohere quota errors are classified", async () => {
  mockFetch(() => new Response(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", code: 429 } }), { status: 429 }));
  assert.equal((await (await handle(chat("openrouter"), extraEnv)).json()).quota.kind, "daily");
  mockFetch(() => new Response(JSON.stringify({ errors: [{ code: 4006, message: "you have used up your daily free allocation of 10,000 neurons" }], success: false }), { status: 429 }));
  const cf = await (await handle(chat("cloudflare"), extraEnv)).json();
  assert.equal(cf.quota.kind, "daily");
  assert.match(cf.error, /^Cloudflare HTTP 429: you have used up your daily free allocation/);
  mockFetch(() => new Response(JSON.stringify({ message: "You are using a Trial key, which is limited to 1000 API calls / month." }), { status: 429 }));
  const co = await (await handle(chat("cohere"), extraEnv)).json();
  assert.equal(co.quota.kind, "monthly");
  assert.match(co.error, /^Cohere HTTP 429: You are using a Trial key/);
});
