# AGENTS.md: TruckeeVibes

Rules for any AI agent (Claude Code, Codex, Cursor, Antigravity) working in this repo. `CLAUDE.md` points here. **Keep this file current**: any change to the stack, commands, data model, or deploy path updates this file in the same commit.

## What this is
truckeevibes.com is a free, plain list of events in Truckee and North Lake Tahoe. Events come from public calendars that have been reviewed and cleared for automated reading, plus a few curated entries. Every event links back to its organizer. It is a sister project of Truckee Lights.

## Stack
- Next.js 16 App Router, static export (`output: 'export'`, `trailingSlash: true`). Client pages load their data in effects only, because the build prerenders with empty env. There is no server runtime, so security comes **only** from Postgres RLS, constraints and RPC grants.
- TypeScript, Tailwind 4; design tokens generated from `src/styles/tokens.json` into `src/styles/tokens.css` (`node scripts/build-tokens.mjs`), Daylight + After dark by `prefers-color-scheme`.
- Supabase: Postgres + Auth (admin password + TOTP MFA: `private.is_admin()` needs a non-anonymous `aal2` JWT whose `amr` has both a `password` and a `totp` entry, plus a row in `public.admins`). Edge Functions (Deno) arrive with the ingest work.
- Cloudflare Pages hosts the static site **and Pages Functions under `functions/`** (GET/HEAD/OPTIONS only, V13): `functions/api/v1/events.ts` serves the public events API (`/api/v1/events`, contract `functions/_lib/events.v1.schema.json`, docs at `/developers/`), with a 5-minute edge cache in the Workers Cache API (`functions/_lib/cache.ts`; a best-effort generation guard, the RPC's `dataAt` in microseconds, keeps an older body from replacing a newer one). No stale fallback: an RPC failure or timeout is a `503` with `Retry-After: 60` and no event data (Amendment W1-2).

## Commands
```bash
nvm use            # Node version from .nvmrc
npm ci
npm run dev
npm run build      # snapshot (empty without env), then static export to out/
npm run lint
npm run typecheck
npm test           # Vitest; scripts/m0-repo.test.mjs reads out/, so build first on a clean checkout; *.dom.test.ts files opt into happy-dom with a `// @vitest-environment happy-dom` first line
npm run test:functions   # Deno tests for the Edge Functions (needs Deno 2)
npm run db:start   # local Supabase stack (sets local-only auth env; don't run bare `supabase start`)
npm run db:reset
npm run db:test    # pgTAP
npm run db:test:rest # PostgREST-level manifest test (needs the running local stack; env from `supabase status -o env`)
npm run test:visual # fixture build + Playwright visual checks (phone and desktop, light and dark; also builds the empty and error state variants into out-empty/ and out-error/; includes e2e/interactions.spec.ts); needs `npx playwright install chromium`
npm run test:lhci  # Lighthouse (mobile, median of 3) on test:visual's out/; needs Chrome (set CHROME_PATH locally)
npm run test:budget # 700-event fixture build: gzipped home HTML <= 100 KiB, <= 300 embedded rows; rebuilds out/
npm run check:repo # secret scan, workflow rules, fixture size, no raw HTML, tokens up to date
npm run ingest     # ingest entry point
npm run classify-report -- --sources <file>  # I3 report: adapters + notices + classifier over live feeds for permitted sources only; submits nothing, output may carry titles so keep it out of CI logs
```
Local env: copy `.env.example` to `.env.local`. It holds the `NEXT_PUBLIC_*` values (Supabase URL and publishable key, Turnstile site key, site URL), all public. The local stack also reads `SUPABASE_AUTH_SITE_URL` and `SUPABASE_AUTH_CAPTCHA_SECRET` through `supabase/config.toml`; `supabase/start-local.sh` (via `npm run db:start`) defaults them to local-only values. Never put a real captcha secret in the repo.

## Layout
- `src/app` (pages: `/`, `/sources/`, `/bot/`, `/about/`, `/developers/`, and noindex `/admin/`), `src/components` (`layout/` Header and Footer, server-only; `home/` Hero, Tiles, FinderBar, PicksRow and PickCard; `filters/` WhenRow, FilterSheet; `ui/` Sheet; `list/` ListApp, Rail, DayGroup, EventRow, EventSheet, AlsoOn, states), `src/lib/lists.ts` (the lists SSOT), `src/lib/filters/` (six-key filter state and predicates), `src/lib/picks.ts` + `src/lib/picksFile.ts` and `src/content/picks.json` (Our picks: schema and lint, build-time read; a bad file fails the build, a pick outside its week is dropped with a warning; `"picks": []` hides the row), `src/lib/data/firstPaint.ts` (build counts and the first-paint rows), `src/config/public-env.ts`, `src/config/features.ts`
- `src/lib/data` (the **only** Supabase caller: `admin.ts` auth, `sources.ts` RPC wrappers, `errors.ts`)
- `functions/` (Cloudflare Pages Functions: `api/v1/events.ts` and `_lib/` query parsing, RPC call, schema-driven shape, fresh cache, CORS; tests are `*.test.ts` next to them, run by `npm test`)
- `supabase/migrations` (schema; never edited after merge), `supabase/tests` (pgTAP), `supabase/functions` (Edge Functions and `_shared/`), `supabase/seed.sql` (fake local data only)
- `scripts` (repo checks and their tests), `ingest` (ingest code, `core/` classifier v2 (`classify`, `ageGrammar`, `negation`, `categoryMaps`, `reasonCodes`), `notices`, `ttusd` (the TTUSD school-calendar include grammar, SSOT; adapter family `html_finalsite` in `adapters/htmlFinalsite.ts`) and `tahoeDonner` (Tahoe Donner date/time grammar, venue directory and the members-only label rule; adapter family `html_tahoedonner` in `adapters/htmlTahoeDonner.ts`), `tools/classify-report.ts`, synthetic `fixtures/`)
- `public/robots.txt` and `public/sitemap.xml` are hand-written: add every new indexable page to the sitemap and keep `/admin/` out of it.
- `.github/workflows/` (`ci.yml`, `ingest.yml`, `rebuild.yml`, signer workflows)

## Invariants (do not break)
- V1 Every table in `public`/`private` has RLS enabled and forced; anon/authenticated have no table privileges at all. Public reads go only through `list_events`, `list_sources_public`, `list_event_pages` and `api_events_v1` (W1; one jsonb envelope, every bound in SQL). The API roles carry explicit statement timeouts (anon `3s`, authenticated `8s`, set in `20261024000100_api_events_v1.sql`).
- V2 Every write goes through an RPC. `svc_*` = `service_role` only (Edge Functions). `admin_*` = `private.is_admin()` (non-anonymous, `aal2`, `amr` has `password` and `totp`).
- V3 The service/secret key exists only in Supabase Edge Function env. The Actions ingest job holds only `INGEST_HMAC_KEY` + the Pages deploy-hook URL. Cloudflare Pages holds no secret.
- V4 No source is fetched unless it is enabled with a `permitted`/`official_api_only` disposition whose `terms_recheck_at` is in the future, and the request kind is in `allowed_methods` (DB trigger + grant + batch + `politeFetch`). Robots/terms fetches are the only exception.
- V5 The source id of an ingest batch comes from a single-use grant, never from the caller.
- V6 No source description text and no source images are stored (one exception: `private.lights_mirror.description`, text from the owner's sister site Truckee Lights only, returned only in `api_events_v1` `scope=lights`). Summaries are ours (templates). Data is rendered as React text only; never `innerHTML`.
- V7 Event ids are immutable; merge/split never re-key (survivor = exported, else oldest).
- V8 `private.lights_exports` is written only by its trigger; its stored columns never change.
- V9 The Ed25519 signing key exists only in the `feed-signing` GitHub Environment (main only), used by a job that runs no `npm install`.
- V10 Fixtures are synthetic text (CI size check).
- V11 Logs carry counts and codes, never payloads, headers or keys.
- V12 Schema changes only through migrations; migrations never edited after merge.
- V13 Pages Functions are GET/HEAD/OPTIONS only, hold no secret, call only anon-granted read RPCs with the publishable key, log counts only, and never forward upstream bodies.

Conventions: every function sets `search_path = ''` and uses fully qualified names. `service_role` has no table access. Each migration ends with the exact EXECUTE allowlist, and `supabase/tests/01_acl.test.sql` asserts it. `source_events.tag_reasons` and `source_event_versions.tag_reasons` hold classifier reason codes (closed list in `private.valid_reason_code`); they are a sibling of `facts`, never part of the facts hash. Notice titles (`private.is_notice_title`, cases with `sibling` and optional `offsets` in `ingest/core/notices.cases.json`) are rejected at ingest; "NO <X> Tonight" counts as a notice with a same-source same-day "<X>" sibling or a series (>= 2 same-source "<X>" events within 14 days, compared on `source_events.title`, `20261022000400_retag_activate.sql`, pgTAP 23); `private.hide_notice_events()` is a one-shot, re-runnable hide kept on purpose. `clean_source_item` strips `kids`/`family` from adult-age or adult-reason items (DR12 mirror). The runner (`ingest/run.ts`) drops notices and cancels a single same-day, same-venue sibling (`applyNotices`, twin of the SQL rule), classifies with v2 (kids/family never from the title; description and age-text positives count only when their sentence has no negation cue, `ingest/core/negation.ts`; a final adult/ambiguous invariant removes them), and logs `tags=… age_ambiguous= conflicts= notices=<dropped>/<cancelled>` as counts only; `parser_version` is `<adapter.version>-c2`. `ingest/core/reasonCodes.ts` must equal the SQL list in order (`scripts/parity-cases.test.mjs`, never skipped). `events.lights_season` is set from the row as written by the trigger `events_zz_lights_pairs` (`private.lights_pairs`: windows Sep 15–Nov 1 / Nov 15–Jan 6 Pacific, `lights_include`, category or `private.lights_keyword_hit`) and refreshed nightly (`tv-lights-pairs`); `api_events_v1` scope=lights returns the live `private.lights_mirror` rows 1:1 plus Vibes events passing `private.shown_on_lights` (live dedupe, removal veto unless `events.lights_override_at` is newer).

TTUSD school calendars (A12, `ttusd-*` sources, family `html_finalsite`): the adapter reads the robots-allowed month pages (`/calendar?cal_date=YYYY-MM-01`, district `/parents-students/calendars/calendars2`) and **never** the ICS export under `/fs/`, which TTUSD's robots.txt disallows and which must never be fetched. `politeFetch` carries a host-family table (`HOST_FAMILIES`, `ttusd.org`): one shared 5 s spacing floor for every `*.ttusd.org` host (seeded before the first request, robots included) and a path guard on every request and redirect hop (`path_not_allowed`; robots redirecting into `/fs/` counts as blocked). A title publishes only if it matches an anchored whole-title template in `ingest/core/ttusd.ts` (`decideSchoolTitle`, cases in `ttusd.cases.json`); everything else is dropped before the database, so trust is `auto`. Widening the grammar means a code edit plus a cases row. For these items the adapter replaces the classifier's categories (`schools` always; kids/family come from the school directory and the template, a school-only exception to classifier v2) and the venue is always the directory venue, never page text. Dedupe (r4: one listing per event per day, or per distinct start time) is `filterSchoolItems` in-feed and `private.ttusd_twin` across feeds (same venue, normalized title, local date and exact start; an all-day copy joins/yields to the timed one; no similarity, no 30-minute window), used by `cluster_and_publish` for `ttusd-%` sources only; `recompute_event` publishes a TTUSD all-day item with a geocoded venue without a time (`rule:publish`).

Tahoe Donner events (A13, source `tahoe-donner`, family `html_tahoedonner`): the adapter reads the server-rendered `/events/` list, the three hint lists (`?categories%5B%5D=94|180|95`, Family Events, Kids Programming, Live Music) and each detail page, and **never** the RSS feed, `/calendar/action~*`, the ai1ec exporter or the WordPress API. `politeFetch` generalizes the host-family table (`HOST_FAMILIES`: `HostFamily = { floorMs, deny, rules }`, now TTUSD and Tahoe Donner): one shared 5 s floor per family, a path guard on every request and hop (`path_not_allowed`), and `FetchOut.finalUrl` (the last hop). A hint list counts only if it is a non-empty strict subset of the main list reached without a redirect; otherwise its hints are ignored and the run continues (a hint list that fails in transport (network/timeout) or returns non-200 is ignored too; every guard still applies). Every Tahoe Donner event is listed (owner decision: no member/public filter). Drops are data-quality only (`oversize | date_unparsed | no_time | long_range | series_unsupported | out_of_window`); weekly series ("Every Thu" headers) yield nothing in v1, and only the page's own header date is read, never body dates. The `members-only` category is a label set only by that adapter (`membersOnly`: a title phrase or one of five exact description sentences); `ingest/run.ts` strips it from every other family, it is not in `OUR_SLUGS` or any source map, and the UI shows it as an access tag (`ACCESS_TAG_LABELS`, `.tg.members`), never as a Rail kind or filter. Trust ships at `review`; `auto` comes only from the follow-up migration after the A13 r7-2 post-deploy gate; widening the badge or the venue directory means a code edit plus a test row.

## CI
`.github/workflows/ci.yml`: job `web` (install, lint, typecheck, build, test, Deno tests, audit, repo checks), job `db` (start the local stack, reset, pgTAP) and job `visual` (Playwright visual checks on a fixture build, then Lighthouse and the HTML budget; uploads screenshots as an artifact). It uses no secrets and no `pull_request_target`; every action is pinned to a commit SHA.
`.github/workflows/ingest.yml`: runs the ingest every 3 hours (cron `10 */3 * * *`, A10 real-time publishing; trusted `auto` sources apply new/edit surges, `found_drop`/`found_zero` still hold every source).
`.github/workflows/rebuild.yml`: a daily (13:00 UTC) and manual call of the Cloudflare Pages deploy hook so the static site rebuilds from fresh data. One `curl` step, `permissions: {}`, no checkout, no `uses:`, no package manager; its only secret is `PAGES_DEPLOY_HOOK_URL`. `scripts/check-workflows.mjs` enforces this.

## Workflow
- Changes go through pull requests to `main`. Agents never deploy, never touch production or a hosted database, and never handle secrets. Merging and deploying are maintainer-only.
- Public repo: no secrets, no `.env` values, no hosted project identifiers, no personal email addresses. The only contact address in the repo is the public takedown address on the bot page.

## PR rule
One focused change per PR. Update this file when the stack, commands, data model or CI change.
