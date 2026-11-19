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
  assert.equal((await handle(req("/api/chat", { token: "nope", body: { messages: [{ role: "user", content: "x" }] } }), env)).status, 401);
  assert.equal(calls.length, 0);
});

test("rejects non-POST", async () => {
  assert.equal((await handle(req("/api/verify", { method: "GET" }), env)).status, 405);
});

test("500 when ACCESS_TOKEN unset", async () => {
  assert.equal((await handle(req("/api/verify"), { ...env, ACCESS_TOKEN: "" })).status, 500);
});

test("verify succeeds with the right token", async () => {
  const res = await handle(req("/api/verify"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("chat uses Gemini first and maps roles", async () => {
  mockFetch(() => geminiOk.clone());
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const res = await handle(req("/api/chat", { body: { messages } }), { ...env, SYSTEM_PROMPT: "be nice" });
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

test("falls back to Groq when Gemini is rate limited", async () => {
  mockFetch((url) => (url.includes("googleapis") ? new Response("quota", { status: 429 }) : groqOk.clone()));
  const res = await handle(req("/api/chat", { body: { messages: [{ role: "user", content: "x" }] } }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.provider, "groq");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.headers.authorization, "Bearer q");
});

test("falls back when Gemini throws (network error)", async () => {
  mockFetch((url) => { if (url.includes("googleapis")) throw new Error("ECONNRESET"); return groqOk.clone(); });
  const res = await handle(req("/api/chat", { body: { messages: [{ role: "user", content: "x" }] } }), env);
  assert.equal((await res.json()).provider, "groq");
});

test("502 when both providers fail", async () => {
  mockFetch(() => new Response("boom", { status: 500 }));
  const res = await handle(req("/api/chat", { body: { messages: [{ role: "user", content: "x" }] } }), env);
  assert.equal(res.status, 502);
});

test("uses Groq alone when no Gemini key", async () => {
  mockFetch(() => groqOk.clone());
  const res = await handle(req("/api/chat", { body: { messages: [{ role: "user", content: "x" }] } }), { ...env, GEMINI_API_KEY: "" });
  assert.equal((await res.json()).provider, "groq");
  assert.equal(calls.length, 1);
});

test("400 on bad message payloads", async () => {
  for (const body of [{}, { messages: [] }, { messages: [{ role: "assistant", content: "x" }] }, { messages: [{ role: "system", content: "x" }] }]) {
    assert.equal((await handle(req("/api/chat", { body }), env)).status, 400);
  }
});
