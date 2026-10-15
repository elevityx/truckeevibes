// Each NEXT_PUBLIC_* must be written out literally so Next can inline it at build.
// Never throw here: `next build` prerenders client pages with empty env in CI.
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '',
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://truckeevibes.com',
} as const;

export function supabaseConfigured(): boolean {
  return publicEnv.supabaseUrl !== '' && publicEnv.supabaseKey !== '';
}
