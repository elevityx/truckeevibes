// Local types for Pages Functions, so `tsc` needs no @cloudflare/workers-types.
export interface Env {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
  CF_PAGES_BRANCH?: string;
}
export interface PagesCtx {
  request: Request;
  env: Env;
  waitUntil(p: Promise<unknown>): void;
}
