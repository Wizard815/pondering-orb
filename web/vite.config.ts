import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the server runs on 8095; Vite proxies the API to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8095", "/mcp": "http://localhost:8095" } },
  build: { outDir: "dist", sourcemap: true },
});
