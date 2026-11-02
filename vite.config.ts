// Builds the extension into dist/: main.js (one ES module), styles.css (when there is CSS) and manifest.json.
// `soup`, `react` and friends are not bundled: soup-externals.mjs turns them into reads of what SOUP provides.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { soupExternals } from "./soup-externals.mjs";

// The Google client (see src/constants.ts): from the environment (the release workflow's secrets), else from the git-ignored
// google-oauth-client.json, else placeholders (CI checks and tests; verify-dist.mjs --release refuses those).
function googleClient(): { id?: string; secret?: string } {
  if (process.env.DRIVE_SYNC_CLIENT_ID) return { id: process.env.DRIVE_SYNC_CLIENT_ID, secret: process.env.DRIVE_SYNC_CLIENT_SECRET };
  if (existsSync("google-oauth-client.json")) {
    const j = JSON.parse(readFileSync("google-oauth-client.json", "utf8"));
    return { id: j.client_id, secret: j.client_secret };
  }
  return {};
}
const client = googleClient();

export default defineConfig({
  define: {
    ...(client.id ? { __DRIVE_SYNC_CLIENT_ID__: JSON.stringify(client.id) } : {}),
    ...(client.secret ? { __DRIVE_SYNC_CLIENT_SECRET__: JSON.stringify(client.secret) } : {}),
  },
  plugins: [
    soupExternals(),
    react({ jsxRuntime: "automatic" }),
    {
      name: "copy-manifest",
      writeBundle() {
        mkdirSync("dist", { recursive: true });
        copyFileSync("manifest.json", "dist/manifest.json");
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    cssCodeSplit: false,
    lib: { entry: "src/main.ts", formats: ["es"], fileName: () => "main.js", cssFileName: "styles" },
  },
});
