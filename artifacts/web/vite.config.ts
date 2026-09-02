import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    // Vite 7 блокує невідомий Host-заголовок (403) — потрібно для локального
    // тесту через cloudflared quick tunnel (випадковий *.trycloudflare.com
    // піддомен щоразу; /sign/:token, Telegram Mini App).
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
});
