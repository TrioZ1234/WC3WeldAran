import { defineConfig } from "vite";

// `data/` holds the pipeline output (terrain.bin, *.json, models, textures).
// It is served as-is rather than bundled: the payload is large and versioned
// by the converter, not by the app build.
export default defineConfig({
  publicDir: "public",
  build: { target: "esnext", outDir: "dist" },
  server: { port: 5173 },
});
