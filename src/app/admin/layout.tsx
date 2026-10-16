import type { Metadata } from 'next';
import { Fraunces } from 'next/font/google';

// The back office keeps its original look (plan section 4.9), so it loads Fraunces; the public root layout does not.
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });

export const metadata: Metadata = { robots: { index: false, follow: false }, alternates: { canonical: '/admin/' }, title: 'Back office' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className={fraunces.variable}>{children}</div>;
}
