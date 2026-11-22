# LLMate

A private LLM chat hosted on Netlify. Only someone holding the access token can use it.

- **Frontend:** a small React app (`src/`, built with Vite and Tailwind CSS) with a token-only login screen and a chat view. A few [Magic UI](https://magicui.design) components (in `src/components/ui/`) add restrained motion: the dot grid and spotlight card on the login screen, messages fading in, a shimmer on the "thinking" note, and a light beam around the message box while a reply streams. Fonts and libraries are bundled and self-hosted; the page loads nothing from other sites.
- **Backend:** one Netlify Function (`netlify/functions/api.mjs`) serving `/api/verify` and `/api/chat`. It checks the token with a constant-time compare, then calls the model you picked for that chat. Models come from three providers, each on its free tier: **Google Gemini**, **Groq** and **Cloudflare Workers AI**. Each provider is optional and its models show up only when its key is set. There is no automatic fallback.
- **Secrets** (the token and the API keys) live only in Netlify environment variables. The browser never sees the provider keys.

Everything here runs on free tiers: Netlify Starter plus the free tier of each provider you turn on. None of them needs a credit card.

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

**Cloudflare Workers AI** (optional, needs two values)
1. Sign up for a free [Cloudflare](https://dash.cloudflare.com) account. The Workers Free plan includes [10,000 Neurons a day](https://developers.cloudflare.com/workers-ai/platform/pricing/), shared across all models and reset at midnight UTC. A Neuron is Cloudflare's usage unit; bigger models use more per reply.
2. Copy your **Account ID** (on the account home page, or under **Workers & Pages**). This is `CLOUDFLARE_ACCOUNT_ID`.
3. Go to **My Profile → API Tokens → Create Token**, start from the **Workers AI** template (or a custom token with **Workers AI - Read** and **Workers AI - Edit**), and copy it. This is `CLOUDFLARE_API_TOKEN`.

Not included, as of November 2026: **OpenRouter** allows only 50 free requests a day without buying credits, mostly to lesser-known models. **Cohere** trial keys are capped at 1,000 calls a month. **NVIDIA** doesn't publish its free limits, and Cloudflare already offers its Nemotron model. **GitHub Models** was retired on July 30, 2026. **Cerebras** now offers only a 30-day trial credit that needs a payment method. **Hugging Face** Inference Providers gives free accounts no monthly credit. **Mistral**'s API needs a paid plan.

You need at least one provider. The model picker only lists models from providers whose key (both values, for Cloudflare) is set.

### Models

All of these are on the providers' free tiers as of November 2026. The picker groups them by provider; the first in each group is that provider's default.

| Provider | Models | Effort levels |
|---|---|---|
| Gemini | Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) | Minimal (default), Low, Medium, High |
| | Gemini 3.5 Flash (`gemini-3.5-flash`) | none |
| | Gemini 3 Flash preview (`gemini-3-flash-preview`) | Minimal, Low, Medium, High (default) |
| | Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`) | none |
| Groq | GPT-OSS 120B and 20B (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`) | Low, Medium (default), High |
| | Qwen 3.8 27B preview (`qwen/qwen3.8-27b`) | none |
| Cloudflare | Llama 3.3 70B, Llama 4 Scout 17B, Llama 3.1 8B | none |
| | GPT-OSS 120B and 20B | Low, Medium (default), High |
| | Qwen 3.8 27B | Low (default), Medium, Max |
| | Qwen3 30B, Qwen 2.5 Coder 32B, DeepSeek R1 Distill 32B, Mistral Small 3.1 24B, Gemma 4 26B, GLM 4.7 Flash, Nemotron 3 120B, Granite 4.0 Micro, SEA-LION v4 27B | none |

Left out on purpose: Gemini 2.5 models (Google now limits them to accounts that used them before), Gemini 3.1 Pro (no free tier), QwQ 32B on Cloudflare (deprecated November 20, 2026), and Cloudflare models that need a paid plan (Kimi K2.6, GLM 5.x, DeepSeek V4 and others).

The list lives in `MODELS` in `netlify/functions/api.mjs`. To add a model or replace a retired one, edit that list and redeploy. If a model is retired upstream, picking it shows the provider's error in the chat. Model lists: [Gemini](https://ai.google.dev/gemini-api/docs/models), [Groq](https://console.groq.com/docs/models), [Cloudflare](https://developers.cloudflare.com/workers-ai/models/).

### 2. Generate your access token

Any long random string works. Pick one of:

```sh
npm run token                       # from this repo, needs Node 20.19+
openssl rand -base64 32             # macOS / Linux
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep it in your password manager. The server refuses tokens shorter than 16 characters; use at least 32.

### 3. Create the Netlify site

1. In [Netlify](https://app.netlify.com), click **Add new site → Import an existing project** and pick this GitHub repo.
2. Leave the build settings empty in the Netlify UI. Netlify reads `netlify.toml`: build command `npm run build`, publish dir `dist`, functions dir `netlify/functions`, Node 22. (If you typed a build command or publish directory into the UI earlier, clear them: UI values override the file.)
3. Before (or right after) the first deploy, open **Site configuration → Environment variables** and add:

| Variable | Required | Value |
|---|---|---|
| `ACCESS_TOKEN` | yes | the token from step 2 |
| `GEMINI_API_KEY` | at least one provider | key from Google AI Studio |
| `GROQ_API_KEY` | at least one provider | key from the Groq console |
| `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` | at least one provider | account ID and Workers AI token from Cloudflare |
| `SYSTEM_PROMPT` | no | instructions sent with every chat |

   Mark `ACCESS_TOKEN` and the keys as **secret** values if your plan offers it, and scope them to **Functions**.
4. **Deploys → Trigger deploy → Deploy site** so the function picks up the variables. Any later change to a variable also needs a redeploy.
5. Open the site, paste your token, and chat.

### Rotating the token

Change `ACCESS_TOKEN` in Netlify and redeploy. Any browser holding the old token is logged out on its next request.

**Rotating the token hides your saved chats.** Chats are filed under a hash of the token, so a new token starts with an empty list. The old chats are not deleted, just unreachable. To get them back, set `ACCESS_TOKEN` to the old value again. To clear them for good, delete the `chats` store under **Blobs** in the Netlify dashboard (or delete each chat in the sidebar before rotating).

## How it works

### The pieces

```mermaid
flowchart TB
    subgraph Browser["Your browser"]
        UI["React app (Vite build)<br/>login screen + chat<br/>(Markdown via marked,<br/>DOMPurify, highlight.js)"]
        LS[("localStorage<br/>token, last provider")]
    end

    subgraph Netlify["Netlify (free tier)"]
        STATIC["Static hosting<br/>dist/ (built from src/)"]
        FN["Netlify Function api.mjs<br/>/api/verify, /api/chat"]
        ENV[("Environment variables<br/>ACCESS_TOKEN, GEMINI_API_KEY,<br/>GROQ_API_KEY, optional overrides")]
    end

    subgraph Providers["LLM providers (free tiers)"]
        GEM["Google Gemini<br/>gemini-3.5-flash-lite"]
        GROQ["Groq<br/>openai/gpt-oss-120b"]
        MORE["Cloudflare Workers AI<br/>Llama, Qwen, Gemma and more"]
    end

    STATIC -- "serves the page" --> UI
    UI <-- "remembers token" --> LS
    UI -- "token + provider + messages" --> FN
    ENV -. "secrets" .-> FN
    FN -- "streaming request<br/>with server-side key" --> GEM
    FN -- "streaming request<br/>with server-side key" --> GROQ
    FN -- "streaming request<br/>with server-side key" --> MORE
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
        UI-->>You: Chat screen with model picker
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

Of the pieces in the diagrams, four handle what you type. **Your browser** shows the open chat. `localStorage` keeps only your access token and your last provider and effort picks. **Netlify** runs the function, so each message passes through Netlify's servers (encrypted in transit with HTTPS), and it **stores your saved chats** in [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), the site's built-in key-value store. They sit in your Netlify account, readable by anyone with access to that account or site, and are not end-to-end encrypted. Delete a chat in the sidebar and it is removed from the store. The function doesn't log prompts or replies. It logs only an error reason when a provider call fails, and Netlify keeps function logs for up to 7 days, depending on your plan ([Netlify logs](https://docs.netlify.com/manage/monitoring/logs/)). **The provider you pick** receives the whole conversation so far with every message, and this is where your data can be reused:

- **Google Gemini (free tier):** under the [Gemini API terms](https://ai.google.dev/gemini-api/terms), Google uses free-tier prompts and responses "to provide, improve, and develop Google products and services and machine learning technologies," and "human reviewers may read, annotate, and process" them. Google says it disconnects them from your account and API key first. The terms explicitly say not to submit sensitive, confidential, or personal information. Turning on billing for the key moves it to Google's paid terms, where prompts aren't used to improve products and are logged only for a limited time for abuse monitoring.
- **Groq:** under the [GroqCloud services agreement](https://console.groq.com/docs/legal/services-agreement) (section 4.2), Groq may not use your inputs or outputs to train models unless you allow it. [By default it doesn't retain them](https://console.groq.com/docs/your-data). It may keep logs for up to 30 days when troubleshooting or investigating suspected abuse, and you can opt out with **Zero Data Retention** under Data Controls in the Groq console.

- **Cloudflare Workers AI:** its data terms weren't reviewed for this README. Check Cloudflare's privacy terms before sending anything sensitive.

**In short,** pick Groq for anything you'd rather not have read or reused, and assume Google may read and reuse anything you send to free-tier Gemini. Only you hold the access token, so nobody else can use the chat or read it through this site. These summaries reflect the providers' terms as of November 2026, so check the links for changes.

### Details

- The login screen sends the token to `POST /api/verify`. On success the token is kept in the browser's `localStorage`, so you stay logged in on that device until you click **Log out**.
- Pick a model next to the title. The list is grouped by provider. You can switch at any point in a chat (except while a reply is streaming). The next message sends the whole conversation so far to the model you picked, and each reply is labeled with the provider and model that wrote it. The last choice is remembered on the device.
- Next to the model is an **Effort** picker, shown only for models that take one (see [Models](#models)), with a one-line note on each level. Gemini 3 takes a thinking level; GPT-OSS and Cloudflare's Qwen 3.8 take a reasoning effort. Higher effort is slower and spends more of the free quota. The choice is remembered per model, sent as `effort` to `/api/chat`, and shown under each reply. The model's thinking itself isn't shown, including models such as DeepSeek R1 Distill that write it into the reply inside `<think>` tags; it only keeps the stream alive so long thinks don't hit the 20-second idle timeout.
- Each message sends the conversation so far to `POST /api/chat` with `Authorization: Bearer <token>`. The function rejects anything without a valid token with `401` before touching any provider.
- **Saved chats.** Each chat is saved after every reply (or error) to Netlify Blobs, with its messages, the model and effort it last used, and a title taken from its first message. The sidebar (the panel icon at the top left; it slides over the chat on phones) lists them newest first, grouped by day, and you can reopen, rename or delete each one. Reopening a chat also switches back to its model and effort (chats saved before the model picker reopen on their provider's default model). Because the chats live on the server, they show up on every device where you log in with the same token.
- Chats are filed in a store named `chats` under `<hash of the token>/<chat id>`, plus a `<hash>/_index` entry with the titles the sidebar lists. Every `/api/chats/*` request (`list`, `get`, `save`, `rename`, `delete`) goes through the same token check as `/api/chat`, and the hash comes from the token on the request, so there is no way to ask for another token's chats. Blobs is free and needs no setup on Netlify: the function just uses it. The store uses strong consistency, so a chat saved on your phone lists right away on your laptop. If two devices save at the same moment, the list repairs itself the next time it loads.
- Replies stream in as the model writes them, with a "thinking" note until the first words arrive. The function relays the provider's stream to the browser as newline-delimited JSON. Each finished reply shows which provider and model answered.
- Messages (yours and the model's) are rendered as Markdown with [marked](https://marked.js.org), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify) (no raw HTML, images, scripts or event handlers), and code blocks get [highlight.js](https://highlightjs.org) colors and a Copy button. The libraries are bundled into the app by Vite, so the strict Content-Security-Policy (`script-src 'self'`, no inline scripts) still holds. The site also sends `noindex` headers.
- While a reply streams, the page doesn't scroll on its own. It jumps to the bottom only when you send a message.

### Limits worth knowing

- Free tiers have per-minute and per-day request caps. When a provider's daily quota or a short per-minute limit is hit, the chat shows a friendly note saying when it resets and suggests another provider. Gemini and Groq count limits per model, so another model from the same provider may still work; Cloudflare's 10,000 Neurons are shared by all its models.
- Netlify caps how long a synchronous function may run (check [Netlify's function limits](https://docs.netlify.com/functions/overview/#default-deployment-options) for your plan). The function gives up if the provider sends nothing for 20 seconds. If Netlify's cap cuts a long streamed answer short, the text so far stays in the chat, marked as stopped early.
- History is capped at the last 40 messages and about 32,000 characters. That is what goes to the provider; a saved chat keeps everything, up to 1,000 messages and 2 million characters.
- Netlify Blobs is included on the free plan. Text chats are tiny, so storage is not a practical concern for one person's use (see [Netlify's pricing](https://www.netlify.com/pricing/) for current limits).

## Run it locally

You can run the whole app (frontend and function) on your own computer with your own API keys.

**Do you need a Netlify account?** No. `netlify dev` runs without logging in and without linking the folder to a Netlify site. It reads your keys from a local `.env` file instead of Netlify's environment variables. You only need an account to deploy.

### What you need

- [Node.js](https://nodejs.org) 20.19 or newer (22 matches what Netlify uses) and npm.
- At least one free API key (Gemini, Groq or Cloudflare). See [Get the free API keys](#1-get-the-free-api-keys) above. These are your own keys, so free-tier usage counts against your own quota.

### Steps

1. **Clone and install.**

   ```sh
   git clone https://github.com/willamesoares/llmate.git
   cd llmate
   npm install
   ```

2. **Install the Netlify CLI.** It runs the Vite dev server and the function together behind one address, the same way Netlify routes them in production.

   ```sh
   npm install -g netlify-cli
   ```

   If you'd rather not install it globally, use `npx netlify-cli dev` in step 5 instead.

3. **Create your `.env` file.**

   ```sh
   cp .env.example .env
   npm run token            # prints a random access token
   ```

   Open `.env` and fill it in:

   ```sh
   ACCESS_TOKEN=paste-the-token-from-npm-run-token
   GEMINI_API_KEY=your-gemini-key     # leave empty to skip Gemini
   GROQ_API_KEY=your-groq-key         # leave empty to skip Groq
   CLOUDFLARE_ACCOUNT_ID=your-account-id   # leave both empty to skip Cloudflare
   CLOUDFLARE_API_TOKEN=your-workers-ai-token
   ```

   The optional `SYSTEM_PROMPT` line works the same as on Netlify (see the table in [Create the Netlify site](#3-create-the-netlify-site)). `.env` is in `.gitignore`, so it won't be committed.

4. **Optional: run the checks.**

   ```sh
   npm test                 # unit tests for the function (providers mocked, no keys needed)
   npm run typecheck        # TypeScript check for the frontend
   ```

5. **Start it.**

   ```sh
   netlify dev
   ```

   The first run can take a minute while the CLI downloads its helpers. When it prints `Local dev server ready: http://localhost:8888`, open that address (not Vite's own port 5173, which has no `/api`), paste the `ACCESS_TOKEN` from your `.env`, and chat. `netlify dev` runs a local stand-in for Netlify Blobs, so saved chats work too; they're kept in a `.netlify/` folder in the project and are separate from the chats on your deployed site. Edits under `src/` reload in the browser. After you change `.env` or the function, stop `netlify dev` with Ctrl+C and start it again.

### If something goes wrong

- **The CLI asks you to log in or link a site.** You can skip it. Nothing in this project needs `netlify login` or `netlify link` to run locally.
- **"That token is not valid".** The token you pasted must match `ACCESS_TOKEN` in `.env` exactly, and be at least 16 characters.
- **A provider's models are missing from the picker.** Its key is empty in `.env`, or you changed `.env` without restarting `netlify dev`.
- **A provider replies with an error.** Check the key in its console, and check the terminal running `netlify dev`, where the function logs the reason.
- **A blank page.** Make sure you opened port 8888. The page uses the same strict Content-Security-Policy locally as in production, and `vite.config.ts` loads React's dev refresh code as a file so the policy doesn't block it.

To add another Magic UI component, run `npx shadcn@latest add @magicui/<name>` (the registry is set up in `components.json`), or copy the file from the [Magic UI docs](https://magicui.design/docs) into `src/components/ui/`.
