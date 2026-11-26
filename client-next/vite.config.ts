import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  base: './',
  plugins: [solidPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-three',
              test: /node_modules\/(three|three-mesh-bvh)\//,
            },
            {
              name: 'vendor-solid',
              test: /node_modules\/solid-js\//,
            },
          ],
        },
      },
    },
  },
});
