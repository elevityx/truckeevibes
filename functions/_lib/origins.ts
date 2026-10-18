// CORS allowlist (spec A5). Etiquette, not access control: the data is public.
export const ORIGINS = [
  'https://truckeelights.com',
  'https://www.truckeelights.com',
  'https://truckeefrights.com',
  'https://www.truckeefrights.com',
  'https://truckeevibes.com',
] as const;

const DEV_ORIGIN = 'http://localhost:3000';

export function allowedOrigin(origin: string | null, branch: string | undefined): string | null {
  if (!origin) return null;
  if ((ORIGINS as readonly string[]).includes(origin)) return origin;
  if (origin === DEV_ORIGIN && branch !== 'main') return origin;
  return null;
}
