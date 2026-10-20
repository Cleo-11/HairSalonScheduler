import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Hide the floating dev badge; it overlaps the bottom buttons on phone screens.
  devIndicators: false,
  // The whole app talks to the separate API (NEXT_PUBLIC_API_URL); no server-side data fetching.
};

export default nextConfig;
