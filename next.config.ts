import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // Inline the (small) stylesheet so it does not block the first paint of the hero.
  experimental: { inlineCss: true },
};

export default nextConfig;
