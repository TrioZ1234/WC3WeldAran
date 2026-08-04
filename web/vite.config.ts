import { defineConfig } from "vite";

// `data/` holds the pipeline output (terrain.bin, *.json, models, textures).
// It is served as-is rather than bundled: the payload is large and versioned
// by the converter, not by the app build.
export default defineConfig({
  publicDir: "public",
  build: { target: "esnext", outDir: "dist" },
  server: {
    port: 5173,
    fs: {
      // The worker imports `../../engine/**`, which lives outside this Vite
      // root. Vite's default allow-list resolves to `web/` (there is no
      // workspace marker above it), so those modules would be answered with
      // HTTP 403 in dev and the sim worker would die on load.
      allow: [".."],
    },
    // The staged `public/data` and `public/assets` are symlinks into build/,
    // which holds thousands of converted files. Watching them is pointless and
    // can exhaust inotify handles.
    watch: { ignored: ["**/public/data/**", "**/public/assets/**", "**/build/**"] },
  },
});
