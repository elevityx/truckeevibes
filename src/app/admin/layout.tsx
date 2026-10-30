import type { Metadata } from 'next';
import { adminFontVariables } from '../fonts/admin';

// The back office keeps its original look (plan section 4.9), so it loads Fraunces (self-hosted, ../fonts/admin.ts); the public root layout does not.

export const metadata: Metadata = { robots: { index: false, follow: false }, alternates: { canonical: '/admin/' }, title: 'Back office' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className={adminFontVariables}>{children}</div>;
}
