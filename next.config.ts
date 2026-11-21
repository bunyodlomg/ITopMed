import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  // HSTS is added per request in src/proxy.ts (not here: these headers are fixed at build
  // time, and a single-computer installation must not pin HTTPS on localhost).
];

// The packaged Windows app (scripts/package/build-win.ts) needs a self-contained
// server; it builds into its own folder so a running local installation is untouched.
const packaging = process.env.ITM_STANDALONE === "1";

const config: NextConfig = {
  // The dev badge would sit on the sidebar's fold button (bottom-left).
  devIndicators: { position: "bottom-right" },
  ...(packaging ? { output: "standalone" as const, distDir: ".next-pkg" } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@node-rs/argon2", "embedded-postgres"],
  experimental: {
    serverActions: { bodySizeLimit: "1mb" },
    // Tree-shake icon imports for smaller client bundles.
    optimizePackageImports: ["lucide-react"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Authenticated pages may contain personal data: never store them in shared or browser caches.
      { source: "/((?!_next/static|icons|manifest.webmanifest|sw.js|offline.html).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default withNextIntl(config);
