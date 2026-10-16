# AGENTS.md: TruckeeVibes

Rules for any AI agent (Claude Code, Codex, Cursor, Antigravity) working in this repo. `CLAUDE.md` points here. **Keep this file current**: any change to the stack, commands, data model, or deploy path updates this file in the same commit.

## What this is
truckeevibes.com is a free, plain list of events in Truckee and North Lake Tahoe. Events come from public calendars that have been reviewed and cleared for automated reading, plus a few curated entries. Every event links back to its organizer. It is a sister project of Truckee Lights.

## Stack
- Next.js 16 App Router, static export (`output: 'export'`, `trailingSlash: true`). Client pages load their data in effects only, because the build prerenders with empty env. There is no server runtime, so security comes **only** from Postgres RLS, constraints and RPC grants.
- TypeScript, Tailwind 4; design tokens generated from `src/styles/tokens.json` into `src/styles/tokens.css` (`node scripts/build-tokens.mjs`), Daylight + After dark by `prefers-color-scheme`.
- Supabase: Postgres + Auth (admin password + TOTP MFA: `private.is_admin()` needs a non-anonymous `aal2` JWT whose `amr` has both a `password` and a `totp` entry, plus a row in `public.admins`). Edge Functions (Deno) arrive with the ingest work.
- Cloudflare Pages hosts the static site.

## Commands
```bash
nvm use            # Node version from .nvmrc
npm ci
npm run dev
npm run build      # snapshot (empty without env), then static export to out/
npm run lint
npm run typecheck
npm test           # Vitest; scripts/m0-repo.test.mjs reads out/, so build first on a clean checkout
npm run test:functions   # Deno tests for the Edge Functions (needs Deno 2)
npm run db:start   # local Supabase stack (sets local-only auth env; don't run bare `supabase start`)
npm run db:reset
npm run db:test    # pgTAP
npm run db:test:rest # PostgREST-level manifest test (needs the running local stack; env from `supabase status -o env`)
npm run test:visual # fixture build + Playwright visual checks (phone and desktop, light and dark); needs `npx playwright install chromium`
npm run check:repo # secret scan, workflow rules, fixture size, no raw HTML, tokens up to date
npm run ingest     # ingest entry point
```
Local env: copy `.env.example` to `.env.local`. It holds the `NEXT_PUBLIC_*` values (Supabase URL and publishable key, Turnstile site key, site URL), all public. The local stack also reads `SUPABASE_AUTH_SITE_URL` and `SUPABASE_AUTH_CAPTCHA_SECRET` through `supabase/config.toml`; `supabase/start-local.sh` (via `npm run db:start`) defaults them to local-only values. Never put a real captcha secret in the repo.

## Layout
- `src/app` (pages: `/`, `/sources/`, `/bot/`, `/about/`, and noindex `/admin/`), `src/components` (`layout/` Header and Footer, server-only), `src/config/public-env.ts`, `src/config/features.ts`
- `src/lib/data` (the **only** Supabase caller: `admin.ts` auth, `sources.ts` RPC wrappers, `errors.ts`)
- `supabase/migrations` (schema; never edited after merge), `supabase/tests` (pgTAP), `supabase/functions` (Edge Functions and `_shared/`), `supabase/seed.sql` (fake local data only)
- `scripts` (repo checks and their tests), `ingest` (ingest code and synthetic `fixtures/`)
- `public/robots.txt` and `public/sitemap.xml` are hand-written: add every new indexable page to the sitemap and keep `/admin/` out of it.
- `.github/workflows/` (`ci.yml`, `ingest.yml`, `rebuild.yml`, signer workflows)

## Invariants (do not break)
- V1 Every table in `public`/`private` has RLS enabled and forced; anon/authenticated have no table privileges at all. Public reads go only through `list_events`, `list_sources_public`, `list_event_pages` and (M3) `feed_lights_snapshot`.
- V2 Every write goes through an RPC. `svc_*` = `service_role` only (Edge Functions). `admin_*` = `private.is_admin()` (non-anonymous, `aal2`, `amr` has `password` and `totp`).
- V3 The service/secret key exists only in Supabase Edge Function env. The Actions ingest job holds only `INGEST_HMAC_KEY` + the Pages deploy-hook URL. Cloudflare Pages holds no secret.
- V4 No source is fetched unless it is enabled with a `permitted`/`official_api_only` disposition whose `terms_recheck_at` is in the future, and the request kind is in `allowed_methods` (DB trigger + grant + batch + `politeFetch`). Robots/terms fetches are the only exception.
- V5 The source id of an ingest batch comes from a single-use grant, never from the caller.
- V6 No source description text and no source images are stored. Summaries are ours (templates). Data is rendered as React text only; never `innerHTML`.
- V7 Event ids are immutable; merge/split never re-key (survivor = exported, else oldest).
- V8 `private.lights_exports` is written only by its trigger; its stored columns never change.
- V9 The Ed25519 signing key exists only in the `feed-signing` GitHub Environment (main only), used by a job that runs no `npm install`.
- V10 Fixtures are synthetic text (CI size check).
- V11 Logs carry counts and codes, never payloads, headers or keys.
- V12 Schema changes only through migrations; migrations never edited after merge.

Conventions: every function sets `search_path = ''` and uses fully qualified names. `service_role` has no table access. Each migration ends with the exact EXECUTE allowlist, and `supabase/tests/01_acl.test.sql` asserts it.

## CI
`.github/workflows/ci.yml`: job `web` (install, lint, typecheck, build, test, Deno tests, audit, repo checks), job `db` (start the local stack, reset, pgTAP) and job `visual` (Playwright visual checks on a fixture build; uploads screenshots as an artifact). It uses no secrets and no `pull_request_target`; every action is pinned to a commit SHA.
`.github/workflows/rebuild.yml`: a daily (13:00 UTC) and manual call of the Cloudflare Pages deploy hook so the static site rebuilds from fresh data. One `curl` step, `permissions: {}`, no checkout, no `uses:`, no package manager; its only secret is `PAGES_DEPLOY_HOOK_URL`. `scripts/check-workflows.mjs` enforces this.

## Workflow
- Changes go through pull requests to `main`. Agents never deploy, never touch production or a hosted database, and never handle secrets. Merging and deploying are maintainer-only.
- Public repo: no secrets, no `.env` values, no hosted project identifiers, no personal email addresses. The only contact address in the repo is the public takedown address on the bot page.

## PR rule
One focused change per PR. Update this file when the stack, commands, data model or CI change.
