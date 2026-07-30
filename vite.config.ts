import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep three in its own chunk so the game code stays cache-friendly.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
