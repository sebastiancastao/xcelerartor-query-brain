import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / worker-based deps used only on the server for OCR of scanned PDFs.
  // Opt them out of the Server Components bundler so they load via Node require.
  serverExternalPackages: ["@napi-rs/canvas", "tesseract.js"],
};

export default nextConfig;
