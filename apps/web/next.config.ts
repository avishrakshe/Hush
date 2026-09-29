import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages export their TypeScript sources directly (see packages/sdk/package.json).
  transpilePackages: ["@hush/x402"],
  // Those sources use NodeNext-style specifiers (`import "./x.js"` for x.ts), which is what makes the SDK's tsc
  // output valid for npm. Turbopack has no extensionAlias yet, so this app builds with webpack (`--webpack`).
  webpack: (config: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return config;
  },
};

export default nextConfig;
