#!/usr/bin/env bash
# "read tdrpd": the conductor runs this from the repo root only when the owner asks (Spec_Kids_Live Amendment K3).
# Reads the TDRPD Rec1 catalog with plain curl, maps youth programs and submits them over the linked Supabase CLI.
# Flags: --dry-run (read + map, submit nothing), --from <dir> (re-map a saved read, no network).
set -euo pipefail
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/tsx ingest/tools/tdrpd-refresh.ts "$@" < /dev/null
