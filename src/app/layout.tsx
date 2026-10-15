import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible_Next, Fraunces } from 'next/font/google';
import './globals.css';

const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });
const atkinson = Atkinson_Hyperlegible_Next({ subsets: ['latin'], variable: '--font-atkinson', display: 'swap' });

const TITLE = 'TruckeeVibes: events in Truckee and North Lake Tahoe';
const DESCRIPTION = 'A free, plain list of what is happening in Truckee and North Lake Tahoe, gathered from local calendars with links back to the organizers.';

export const metadata: Metadata = {
  metadataBase: new URL('https://truckeevibes.com'),
  alternates: { canonical: '/' },
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: 'website', url: '/', siteName: 'TruckeeVibes', title: TITLE, description: DESCRIPTION },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0B1626' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${atkinson.variable}`}>
      <body>{children}</body>
    </html>
  );
}
