import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the site runs on its own port and forwards every API call to the Clynx Cloud server, so the browser sees ONE origin and the session cookie works exactly as it does in production.
const API = process.env.CLYNX_API_URL ?? "http://localhost:8787";
const apiPaths = ["/auth", "/web", "/admin", "/billing", "/devices", "/me", "/releases", "/support/requests", "/plans", "/dev", "/health"];

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  server: { port: 5180, proxy: Object.fromEntries(apiPaths.map((p) => [p, { target: API, changeOrigin: false }])) },
  test: { environment: "node" },
});
