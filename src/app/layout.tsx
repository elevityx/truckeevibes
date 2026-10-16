import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible_Next, Bricolage_Grotesque } from 'next/font/google';
import './globals.css';

const bricolage = Bricolage_Grotesque({ subsets: ['latin'], weight: ['700', '800'], variable: '--font-bricolage', display: 'swap', preload: false });
const atkinson = Atkinson_Hyperlegible_Next({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-atkinson', display: 'swap' });

const TITLE = 'TruckeeVibes: events in Truckee and North Lake Tahoe';
const DESCRIPTION = 'A free, plain list of what is happening in Truckee and North Lake Tahoe, gathered from local calendars with links back to the organizers.';

export const metadata: Metadata = {
  metadataBase: new URL('https://truckeevibes.com'),
  alternates: { canonical: '/' },
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: 'website', url: '/', siteName: 'TruckeeVibes', title: TITLE, description: DESCRIPTION },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32' },
      { url: '/favicon-16.png', sizes: '16x16' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f2ee' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1a2b' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${atkinson.variable}`}>
      <body>{children}</body>
    </html>
  );
}
