#!/usr/bin/env bash
# "read manual" (Spec_Manual_Sources M1): the conductor runs this from the repo root only when the owner asks. Never scheduled.
#   scripts/manual-read.sh <slug>   read one manual-only source (tdrpd-rec1 -> scripts/tdrpd-refresh.sh)
#   scripts/manual-read.sh all      every enabled manual-only source once, in slug order (pending read requests listed first)
#   scripts/manual-read.sh requests   list pending read requests (Sources V2); reads nothing
#   scripts/manual-read.sh requested  read each pending request once through its request-bound grant; a refusal is skipped
# Per-source exit: 0 ok, 1 failed, 2 blocked (recorded, source disabled), 3 grant refused (read in the last 24 h) or request
# withdrawn: nothing read. `all` and `requested` count a refusal as skipped and exit with the worst other code; a failed list (CLI
# not linked, login expired) exits 1.
# MANUAL_READ_TS / MANUAL_TDRPD replace the two readers (tests only).
set -euo pipefail
cd "$(dirname "$0")/.."
READ_TS=${MANUAL_READ_TS:-"./node_modules/.bin/tsx ingest/tools/manual-read.ts"}
TDRPD=${MANUAL_TDRPD:-scripts/tdrpd-refresh.sh}
one() {  # one <slug> [--requested]
  local rc=0
  if [ "$1" = "tdrpd-rec1" ]; then $TDRPD ${2:+"$2"} < /dev/null || rc=$?; else $READ_TS ${2:+"$2"} "$1" < /dev/null || rc=$?; fi
  return "$rc"
}
case "${1:-}" in
  ""|-h|--help) echo "usage: scripts/manual-read.sh <slug>|all|requests|requested"; exit 1 ;;
  requests)
    $READ_TS --requests < /dev/null || { echo "manual-read requests: could not list requests (is the Supabase CLI linked?)"; exit 1; }
    exit 0 ;;
  requested)
    slugs=$($READ_TS --requests --slugs < /dev/null) || { echo "manual-read requested: could not list requests (is the Supabase CLI linked?)"; exit 1; }
    if [ -z "$slugs" ]; then echo "manual-read requested: no pending read requests"; exit 0; fi
    worst=0
    for s in $slugs; do
      rc=0; one "$s" --requested || rc=$?
      if [ "$rc" = "3" ]; then echo "manual-read $s: skipped (request withdrawn, or read in the last 24 h)"; continue; fi
      if [ "$rc" -gt "$worst" ]; then worst=$rc; fi
    done
    echo "manual-read requested: done (worst exit $worst)"
    exit "$worst" ;;
  all)
    echo "manual-read all: pending read requests:"
    $READ_TS --requests < /dev/null || echo "manual-read all: could not list requests"
    worst=0
    slugs=$($READ_TS --list < /dev/null) || { echo "manual-read all: could not list sources (is the Supabase CLI linked?)"; exit 1; }
    for s in $slugs; do
      rc=0; one "$s" || rc=$?
      if [ "$rc" = "3" ]; then echo "manual-read $s: skipped (grant refused: read in the last 24 h)"; continue; fi
      if [ "$rc" -gt "$worst" ]; then worst=$rc; fi
    done
    echo "manual-read all: done (worst exit $worst)"
    exit "$worst" ;;
  *) one "$1" ;;
esac
