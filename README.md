# LookLens

Upload an outfit photo → a vision model detects each garment → the app crops each
piece and sources buy links via live web search and/or the Channel3 catalog.

This is a Vite + React app with two Vercel serverless functions that keep your API
keys server-side.

---

## What changed from the original single-file component

The component originally ran against `api.anthropic.com`. It now uses **OpenAI
GPT-4o** instead. The browser must never hold an API key, so two pieces make this
work:

1. **OpenAI calls go through `/api/openai`** (a serverless function holding
   `OPENAI_API_KEY`) instead of hitting `api.openai.com` directly.
2. **Model is `gpt-4o`**, called via OpenAI's **Responses API**
   (`/v1/responses`), which supports both image input (garment detection) and the
   built-in `web_search` tool (sourcing) from one endpoint.

Your key lives only in environment variables — it is never shipped to the browser.

---

## Run it locally

Install once:

```bash
npm install
```

Then pick one of two modes:

**UI only** (fast, but the detect/search buttons will 404 — Vite doesn't run the
serverless functions):

```bash
npm run dev
```

**Full app with the AI features working** — use the Vercel CLI, which runs the
frontend *and* the `/api` functions together:

```bash
npm i -g vercel          # one time
cp .env.example .env     # then paste your OPENAI_API_KEY into .env
vercel dev
```

Open the URL it prints (usually http://localhost:3000).

---

## Deploy to Vercel

1. Push this folder to a Git repo (GitHub/GitLab/Bitbucket).
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
   Vercel auto-detects Vite (build command `vite build`, output `dist`) and the
   `/api` functions. No config needed.
3. Before (or right after) the first deploy, add your environment variable:
   **Project → Settings → Environment Variables**
   - `OPENAI_API_KEY` = your key from https://platform.openai.com/api-keys
   - `CHANNEL3_API_KEY` = *(optional, only for the Channel3 backend)*
4. Deploy. If you added the env var after the first build, hit **Redeploy** so it
   takes effect.

That's it — your app is live at `https://<your-project>.vercel.app`.

> CLI alternative: run `vercel` from this folder to deploy, then
> `vercel env add OPENAI_API_KEY` to set the key.

---

## Sourcing backends

- **WEB SEARCH** (default) — works as soon as `OPENAI_API_KEY` is set. Nothing
  else required.
- **CHANNEL3 / A/B BOTH** — optional. Requires `CHANNEL3_API_KEY`. In the app's
  **PROXY URL** field, enter your deployed origin (e.g.
  `https://your-project.vercel.app`); the frontend appends `/api/channel3`. The
  Channel3 image-search field mapping lives in `api/channel3.js` — adjust it there
  if your Channel3 plan's schema differs.

---

## Project layout

```
api/
  openai.js        serverless proxy → OpenAI Responses API (required)
  channel3.js      serverless proxy → Channel3 search (optional)
src/
  LookLens.jsx     the app (your original component, 2 lines changed)
  main.jsx         React entry point
  index.css        Tailwind v4 import
index.html
vite.config.js     React + Tailwind v4 plugins
```
