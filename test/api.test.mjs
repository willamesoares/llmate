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

const ok = (obj) => new Response(JSON.stringify(obj), { status: 200 });
const geminiOk = ok({ candidates: [{ content: { parts: [{ text: "hi from gemini" }] } }] });
const groqOk = ok({ choices: [{ message: { content: "hi from groq" } }] });

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

test("gemini: maps roles and sends system prompt", async () => {
  mockFetch(() => geminiOk.clone());
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const res = await handle(chat("gemini", messages), { ...env, SYSTEM_PROMPT: "be nice" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.provider, "gemini");
  assert.equal(data.text, "hi from gemini");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].opts.headers["x-goog-api-key"], "g");
  const sent = JSON.parse(calls[0].opts.body);
  assert.deepEqual(sent.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(sent.systemInstruction.parts[0].text, "be nice");
});

test("groq: calls only Groq", async () => {
  mockFetch(() => groqOk.clone());
  const res = await handle(chat("groq"), { ...env, SYSTEM_PROMPT: "be nice" });
  const data = await res.json();
  assert.equal(data.provider, "groq");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.groq\.com/);
  assert.equal(calls[0].opts.headers.authorization, "Bearer q");
  assert.deepEqual(JSON.parse(calls[0].opts.body).messages[0], { role: "system", content: "be nice" });
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
