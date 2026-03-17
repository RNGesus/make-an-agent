import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  plugins: [tanstackStart({ spa: { enabled: true } }), react()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_API_TARGET ?? "http://127.0.0.1:4310",
        changeOrigin: true,
      },
    },
  },
});
