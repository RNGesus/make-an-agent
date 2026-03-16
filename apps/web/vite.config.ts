import { defineConfig } from "vite-plus";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_API_TARGET ?? "http://127.0.0.1:4310",
        changeOrigin: true,
      },
    },
  },
});
