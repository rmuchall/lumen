import {defineConfig} from "vite";

export default defineConfig({
  build: {
    assetsInlineLimit: 0,
  },
  clearScreen: false,
  root: "web",
  server: {
    port: 1420,
    strictPort: true,
  },
});
