#!/bin/sh
# Start the LOCAL Supabase stack with local-only auth defaults (spec A1b).
# config.toml reads these through env(...) so `supabase config push` can never ship test values.
# The captcha default is Cloudflare's public always-pass TEST secret (accepts XXXX.DUMMY.TOKEN.XXXX).
: "${SUPABASE_AUTH_SITE_URL:=http://localhost:3000}"
: "${SUPABASE_AUTH_CAPTCHA_SECRET:=1x0000000000000000000000000000000AA}"
export SUPABASE_AUTH_SITE_URL SUPABASE_AUTH_CAPTCHA_SECRET
exec supabase start "$@"
