import { defineConfig } from "vite";

export default defineConfig({
  // @jsquash/jpeg loads its mozjpeg WASM via import.meta.url. Pre-bundling by
  // esbuild breaks that resolution, so exclude it from dep optimization.
  optimizeDeps: {
    exclude: ["@jsquash/jpeg"],
  },
});
