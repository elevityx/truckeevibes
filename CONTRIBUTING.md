# Contributing to TruckeeVibes

Thanks for helping. This is a small, public, open-source project, and outside contributors (and their AI agents) are welcome.

## Prerequisites

- Node, at the version in [`.nvmrc`](.nvmrc)
- Docker
- Supabase CLI 2.109 or newer
- Deno 2 (only for `npm run test:functions`)

## Local quickstart

```sh
nvm use && npm ci && npm run db:start && npm run db:reset && cp .env.example .env.local
```

`npm run db:start` wraps `supabase start` with local-only auth defaults, so use it instead of calling `supabase start` directly. Paste the publishable key from `supabase status` into `.env.local`, then run `npm run dev`.

You develop against the **local** Supabase stack only. Never point your checkout at a hosted project, and never ask for or use someone else's secrets. CI on fork pull requests runs without secrets by design.

## Tests and checks

| Command | What it covers |
| :--- | :--- |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript |
| `npm run build` | Static export to `out/` |
| `npm test` | Unit tests (Vitest); run `npm run build` first on a clean checkout |
| `npm run test:functions` | Deno tests for Edge Functions |
| `npm run db:test` | pgTAP database tests (needs the local stack) |
| `npm run check:repo` | Secret scan, workflow rules, fixture size, no raw HTML |

Run lint, typecheck, build and tests before you open a pull request. Run the database tests whenever you touch `supabase/`.

## Rules

- **Migrations only.** Schema changes go through new files in `supabase/migrations/`. Never edit a migration that has been merged.
- **Every new function needs an explicit `grant execute`** on its exact signature, and an update to the ACL allowlist test in `supabase/tests`.
- **RLS, auth and grant changes need pgTAP proof** that the policy holds, and get extra review.
- **No secrets.** Only public values (the Supabase URL, the publishable key) may appear in client code. Never commit service keys, database passwords, or real `.env*` files.
- **Nothing private** in code, commits or pull request descriptions: no keys, project identifiers, or internal plans.
- **Fixtures are synthetic.** Keep the structure of a real response and replace all human text; see [`ingest/fixtures/README.md`](ingest/fixtures/README.md).
- **Small pull requests to `main`.** One focused change each; commit messages are imperative and describe one change.
- **Keep docs current.** If you change the stack, commands, data model or CI, update [`AGENTS.md`](AGENTS.md) in the same pull request.
- Merging and deploying are maintainer-only.

## Working with AI agents

Agents read [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` points to it). It holds the invariants that must not be broken. If you use an agent, you are responsible for what it submits.

## Reporting security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
