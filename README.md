# LLMate

A private LLM chat hosted on Netlify. Only someone holding the access token can use it.

- **Frontend:** one static page (`public/index.html`) with a token-only login screen and a chat view. No build step, no dependencies.
- **Backend:** one Netlify Function (`netlify/functions/api.mjs`) serving `/api/verify` and `/api/chat`. It checks the token with a constant-time compare, then calls the provider you picked for that chat: **Google Gemini** (free tier, Flash-Lite model) or **Groq** (free tier). There is no automatic fallback.
- **Secrets** (the token and both API keys) live only in Netlify environment variables. The browser never sees the provider keys.

Everything here runs on free tiers: Netlify Starter, Gemini API free tier and Groq free tier.

## Deploy

### 1. Get the free API keys

**Gemini**
1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key**. No billing account is needed for the free tier.
3. Copy the key. This is `GEMINI_API_KEY`.

> Note: on the free tier Google may use your prompts to improve its products. Don't send anything you wouldn't want reviewed. Groq does not train on API data.

**Groq**
1. Go to the [Groq console](https://console.groq.com/keys) and sign up.
2. Click **Create API Key** and copy it. This is `GROQ_API_KEY`.

You can deploy with only one of the two keys; the provider picker only lists providers whose key is set.

### 2. Generate your access token

Any long random string works. Pick one of:

```sh
npm run token                       # from this repo, needs Node 18+
openssl rand -base64 32             # macOS / Linux
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep it in your password manager. The server refuses tokens shorter than 16 characters; use at least 32.

### 3. Create the Netlify site

1. In [Netlify](https://app.netlify.com), click **Add new site → Import an existing project** and pick this GitHub repo.
2. Leave the build command empty. Netlify reads `netlify.toml` (publish dir `public`, functions dir `netlify/functions`).
3. Before (or right after) the first deploy, open **Site configuration → Environment variables** and add:

| Variable | Required | Value |
|---|---|---|
| `ACCESS_TOKEN` | yes | the token from step 2 |
| `GEMINI_API_KEY` | one of the two | key from Google AI Studio |
| `GROQ_API_KEY` | one of the two | key from the Groq console |
| `GEMINI_MODEL` | no | defaults to `gemini-3.5-flash-lite` |
| `GROQ_MODEL` | no | defaults to `openai/gpt-oss-120b` |
| `SYSTEM_PROMPT` | no | instructions sent with every chat |

   Mark `ACCESS_TOKEN` and the keys as **secret** values if your plan offers it, and scope them to **Functions**.
4. **Deploys → Trigger deploy → Deploy site** so the function picks up the variables. Any later change to a variable also needs a redeploy.
5. Open the site, paste your token, and chat.

If a default model is retired, set `GEMINI_MODEL` or `GROQ_MODEL` to a current one from the [Gemini models list](https://ai.google.dev/gemini-api/docs/models) or [Groq models list](https://console.groq.com/docs/models) and redeploy.

### Rotating the token

Change `ACCESS_TOKEN` in Netlify and redeploy. Any browser holding the old token is logged out on its next request.

## How it works

- The login screen sends the token to `POST /api/verify`. On success the token is kept in the browser's `localStorage`, so you stay logged in on that device until you click **Log out**.
- Pick **Gemini** or **Groq** in the dropdown next to the title. The choice locks once that provider has answered in the chat; click **New chat** to switch. If the first request fails (for example, a rate limit), you can still change it. The last choice is remembered on the device.
- Each message sends the conversation so far to `POST /api/chat` with `Authorization: Bearer <token>`. The function rejects anything without a valid token with `401` before touching any provider.
- The chat history lives only in the open tab. **New chat** or a reload clears it. Nothing is stored server-side.
- Replies stream in as the model writes them, with a "thinking" note until the first words arrive. The function relays the provider's stream to the browser as newline-delimited JSON. Each finished reply shows which provider and model answered.
- Model output is shown as plain text (never parsed as HTML), and the site sends a strict Content-Security-Policy plus `noindex` headers.

### Limits worth knowing

- Free tiers have per-minute and per-day request caps. When a provider's daily quota (or a short per-minute limit) is hit, the chat shows a friendly note saying when it resets and suggests the other provider.
- Netlify caps how long a synchronous function may run (check [Netlify's function limits](https://docs.netlify.com/functions/overview/#default-deployment-options) for your plan). The function gives up if the provider sends nothing for 20 seconds. If Netlify's cap cuts a long streamed answer short, the text so far stays in the chat, marked as stopped early.
- History is capped at the last 40 messages and about 32,000 characters.

## Local development

```sh
npm test                 # unit tests for the function (providers mocked)
npm i -g netlify-cli
cp .env.example .env     # fill in your values
netlify dev              # serves the page and function at http://localhost:8888
```
