import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicEnv } from '@/config/public-env';

let client: SupabaseClient | null = null;

/** Lazy singleton. Call only inside effects or handlers, never during render. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}
