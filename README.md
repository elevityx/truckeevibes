# TruckeeVibes

A free, plain list of events in Truckee and North Lake Tahoe. Events are gathered from public calendars whose terms allow automated reading, every event links back to its organizer, and nothing is copied beyond the facts (title, time, place, link). Next.js static site on Cloudflare Pages, Supabase for data.

## Quickstart

Prerequisites: Node (see `.nvmrc`), Docker, and the Supabase CLI.

```sh
nvm use && npm ci && npm run db:start && npm run db:reset && cp .env.example .env.local
```

`npm run db:start` wraps `supabase start` with local-only auth defaults, so use it instead of calling `supabase start` directly. Paste the publishable key from `supabase status` into `.env.local`, then `npm run dev`.

## Tests

- `npm test` (unit; build first on a clean checkout)
- `npm run db:test` (pgTAP, needs the local stack)
- `npm run check:repo` (secret scan and repo rules)

## Crawler

How our crawler behaves is described at [truckeevibes.com/bot/](https://truckeevibes.com/bot/). Organizers can opt out at takedown@truckeevibes.com.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md) and the [security policy](SECURITY.md). Licensed under the [MIT License](LICENSE).
