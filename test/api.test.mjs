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

const chat = (provider, messages = [{ role: "user", content: "x" }]) =>
  req("/api/chat", { body: { provider, messages } });

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
