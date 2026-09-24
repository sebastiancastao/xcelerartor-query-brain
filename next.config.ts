import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The web agent launches @sparticuz/chromium on Vercel. Its compressed
  // Chromium binary (bin/*.br) is read from disk at runtime, not imported,
  // so the file tracer can't see it; include it in the web agent's function.
  outputFileTracingIncludes: {
    "/api/web-agent/orders/**": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
