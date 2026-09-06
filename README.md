# LifeOS AI

AI life organizer — bilingual (AR / EN). Organizes daily & weekly routines, tasks, habits, and AI coaching. Billing via USDT (TRC20) to the owner's Trust Wallet.

## Stack
- Backend: Node.js + Express (runs locally and on Vercel as a serverless function)
- Database: SQLite (dev/preview, via Node built-in `node:sqlite`) **or** PostgreSQL via `DATABASE_URL` (Vercel/Neon/any Postgres)
- Auth: JWT + bcrypt
- AI: OpenAI-compatible provider (configurable), with an offline rule-based assistant fallback
- Payments: manual USDT TRC20 verification + owner admin panel

## Run locally
```bash
cp .env.example .env   # edit: JWT_SECRET, OWNER_EMAIL, OWNER_PASSWORD, TRUST_WALLET_ADDRESS, AI_API_KEY...
npm install
npm start              # http://localhost:3000
```
If `DATABASE_URL` is empty (or `FORCE_SQLITE=true` locally), it uses local SQLite automatically.

## Deploy to Vercel (recommended)
1. Push this repo to GitHub.
2. In Vercel: **New Project → Import your GitHub repo**.
3. Create a Postgres database from Vercel Storage (or use Neon/Supabase):
   - Copy the connection string into Vercel env var `DATABASE_URL` (e.g. `postgresql://...`).
4. Add env vars (Project Settings → Environment Variables):
   - `DATABASE_URL`, `JWT_SECRET`, `OWNER_EMAIL`, `OWNER_PASSWORD`, `TRUST_WALLET_ADDRESS`, `AI_ENABLED`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`.
5. Redeploy. The API is served as `api/index.js` and static pages come from `public/`.

Endpoints:
- `/` — landing page
- `/app` — user app
- `/admin` — owner admin
- `/api/health`, `/api/config/public`, `/api/auth/*`, `/api/tasks`, `/api/habits`, `/api/chat`, `/api/checkout`, `/api/payments/:id`, `/api/admin/*`

## Payment flow
1. User selects Pro/Life.
2. App shows USDT (TRC20) address + amount + QR.
3. User sends USDT from Trust Wallet.
4. User pastes transaction hash → status `submitted`.
5. Owner logs into `/admin`, verifies TX on TRON explorer, clicks Confirm.
6. User's plan is updated (Pro = 30 days, Life = lifetime).

## Honesty rules (important)
- No fake user counts, no guaranteed income claims.
- Admin panel shows real revenue only.
- Owner never shares seed phrase or private keys with anyone.

## AI
Enable real AI by adding to `.env`:
```
AI_ENABLED=true
AI_API_KEY=...
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```
Works with any OpenAI-compatible endpoint (OpenAI, Groq, OpenRouter, Ollama...).

## Files
- `src/app.js` — Express app (exported for Vercel)
- `src/db.js` — database layer (SQLite/Postgres auto-switch)
- `src/ai.js` — AI layer
- `server.js` — local entrypoint
- `api/index.js` — Vercel serverless entrypoint
- `public/` — static site
