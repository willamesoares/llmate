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

### The pieces

```mermaid
flowchart TB
    subgraph Browser["Your browser"]
        UI["index.html<br/>login screen + chat<br/>(Markdown via vendored marked,<br/>DOMPurify, highlight.js)"]
        LS[("localStorage<br/>token, last provider")]
    end

    subgraph Netlify["Netlify (free tier)"]
        STATIC["Static hosting<br/>public/"]
        FN["Netlify Function api.mjs<br/>/api/verify, /api/chat"]
        ENV[("Environment variables<br/>ACCESS_TOKEN, GEMINI_API_KEY,<br/>GROQ_API_KEY, optional overrides")]
    end

    subgraph Providers["LLM providers (free tiers)"]
        GEM["Google Gemini<br/>gemini-3.5-flash-lite"]
        GROQ["Groq<br/>openai/gpt-oss-120b"]
    end

    STATIC -- "serves the page" --> UI
    UI <-- "remembers token" --> LS
    UI -- "token + provider + messages" --> FN
    ENV -. "secrets" .-> FN
    FN -- "streaming request<br/>with server-side key" --> GEM
    FN -- "streaming request<br/>with server-side key" --> GROQ
    FN -- "reply streamed back<br/>as NDJSON" --> UI
```

The browser only ever talks to your own Netlify site. The provider API keys live in Netlify environment variables and are used only inside the function, so they never reach the browser.

### The user flow

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant UI as Browser (chat page)
    participant FN as Netlify Function
    participant P as Gemini or Groq

    You->>UI: Open the site
    UI->>UI: Saved token in localStorage?
    alt No saved token
        UI-->>You: Show login screen
        You->>UI: Paste access token
    end
    UI->>FN: POST /api/verify (Bearer token)
    FN->>FN: Constant-time compare with ACCESS_TOKEN
    alt Token wrong
        FN-->>UI: 401
        UI-->>You: "That token is not valid"
    else Token right
        FN-->>UI: 200 + providers that have keys
        UI-->>You: Chat screen with provider dropdown
    end

    You->>UI: Pick provider, type a message
    UI-->>You: "Gemini is thinking..."
    UI->>FN: POST /api/chat (token, provider, history)
    FN->>FN: Check token, provider and message size
    FN->>P: Streaming request with the server-side API key
    alt Quota or error
        P-->>FN: 429 / 4xx / 5xx
        FN-->>UI: JSON error (429 includes daily vs per-minute)
        UI-->>You: Friendly quota note or error message
    else Success
        P-->>FN: Text chunks (server-sent events)
        loop For each chunk
            FN-->>UI: delta event (NDJSON line)
            UI-->>You: Reply grows, rendered as sanitized Markdown
        end
        FN-->>UI: done event
        UI-->>You: Code highlighted, provider and model shown
    end
```

### Who can see your chats

Of the pieces in the diagrams, four handle what you type. **Your browser** holds the conversation only in the open tab. It is not saved, and a reload or **New chat** clears it. `localStorage` keeps only your access token and the last provider you picked. **Netlify** runs the function, so each message passes through Netlify's servers (encrypted in transit with HTTPS). The function doesn't store chats or log prompts or replies. It logs only an error reason when a provider call fails, and Netlify keeps function logs for up to 7 days, depending on your plan ([Netlify logs](https://docs.netlify.com/manage/monitoring/logs/)). **The provider you pick** receives the whole conversation so far with every message, and this is where your data can be reused:

- **Google Gemini (free tier):** under the [Gemini API terms](https://ai.google.dev/gemini-api/terms), Google uses free-tier prompts and responses "to provide, improve, and develop Google products and services and machine learning technologies," and "human reviewers may read, annotate, and process" them. Google says it disconnects them from your account and API key first. The terms explicitly say not to submit sensitive, confidential, or personal information. Turning on billing for the key moves it to Google's paid terms, where prompts aren't used to improve products and are logged only for a limited time for abuse monitoring.
- **Groq:** under the [GroqCloud services agreement](https://console.groq.com/docs/legal/services-agreement) (section 4.2), Groq may not use your inputs or outputs to train models unless you allow it. [By default it doesn't retain them](https://console.groq.com/docs/your-data). It may keep logs for up to 30 days when troubleshooting or investigating suspected abuse, and you can opt out with **Zero Data Retention** under Data Controls in the Groq console.

**In short,** pick Groq for anything you'd rather not have read or reused, and assume Google may read and reuse anything you send to free-tier Gemini. Only you hold the access token, so nobody else can use the chat or read it through this site. These summaries reflect the providers' terms as of November 2026, so check the links for changes.

### Details

- The login screen sends the token to `POST /api/verify`. On success the token is kept in the browser's `localStorage`, so you stay logged in on that device until you click **Log out**.
- Pick **Gemini** or **Groq** in the dropdown next to the title. You can switch at any point in a chat (except while a reply is streaming). The next message sends the whole conversation so far to the provider you picked, and each reply is labeled with the provider and model that wrote it. The last choice is remembered on the device.
- Each message sends the conversation so far to `POST /api/chat` with `Authorization: Bearer <token>`. The function rejects anything without a valid token with `401` before touching any provider.
- The chat history lives only in the open tab. **New chat** or a reload clears it. Nothing is stored server-side.
- Replies stream in as the model writes them, with a "thinking" note until the first words arrive. The function relays the provider's stream to the browser as newline-delimited JSON. Each finished reply shows which provider and model answered.
- Messages (yours and the model's) are rendered as Markdown with [marked](https://marked.js.org), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify) (no raw HTML, images, scripts or event handlers), and code blocks get [highlight.js](https://highlightjs.org) colors and a Copy button. The libraries are vendored in `public/vendor/`, so the strict Content-Security-Policy (`script-src 'self'`) still holds. The site also sends `noindex` headers.
- While a reply streams, the page doesn't scroll on its own. It jumps to the bottom only when you send a message.

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
