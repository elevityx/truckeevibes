import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { 'react/no-danger': 'error' } },
  globalIgnores(['out/**', 'out-*/**', '.next/**', 'supabase/**', 'next-env.d.ts']),
]);
