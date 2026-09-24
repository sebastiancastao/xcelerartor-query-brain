import type { NextConfig } from "next";

// Which sites may show the web agent page in an iframe. Space-separated
// origins, e.g. "https://mail.missiveapp.com https://app.example.com".
// Unset means any site may embed it (no frame restriction is sent).
const frameAncestors = process.env.WEB_AGENT_FRAME_ANCESTORS?.trim();

const nextConfig: NextConfig = {
  // The web agent launches @sparticuz/chromium on Vercel. Its compressed
  // Chromium binary (bin/*.br) is read from disk at runtime, not imported,
  // so the file tracer can't see it; include it in the web agent's function.
  // playwright-core also require()s its browsers.json by a path built at
  // runtime, the moment it is imported; without it every web agent route
  // crashes on load (seen in production as an empty HTTP 500).
  outputFileTracingIncludes: {
    "/api/web-agent/**": ["./node_modules/playwright-core/browsers.json"],
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
