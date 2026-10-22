import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce .next/standalone for the production image: only the traced runtime
  // files are shipped, and the server starts with `node server.js`.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
