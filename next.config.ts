import type { NextConfig } from "next";

// Which sites may show the web agent page in an iframe. Space-separated
// origins, e.g. "https://mail.missiveapp.com https://app.example.com".
// Unset means any site may embed it (no frame restriction is sent).
const frameAncestors = process.env.WEB_AGENT_FRAME_ANCESTORS?.trim();

const nextConfig: NextConfig = {
  // The web agent launches @sparticuz/chromium on Vercel. Its compressed
  // Chromium binary (bin/*.br) is read from disk at runtime, not imported,
  // so the file tracer can't see it; include it in the web agent's function.
  outputFileTracingIncludes: {
    "/api/web-agent/orders/**": ["./node_modules/@sparticuz/chromium/bin/**"],
  },

  async headers() {
    if (!frameAncestors) return [];
    return [
      {
        source: "/web-agent",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors 'self' ${frameAncestors}` }],
      },
    ];
  },
};

export default nextConfig;
