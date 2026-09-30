import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages project site: https://1004913938-tech.github.io/ink-surge/
  base: process.env.GITHUB_PAGES === '1' ? '/ink-surge/' : '/',
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // The screenshot harness writes PNGs into the repo. Without this, vite
      // sees the write, triggers a full reload, and destroys the in-flight
      // page.evaluate — which silently truncated capture runs mid-shot-list.
      ignored: ['**/shots/**', '**/.scratch*/**'],
    },
  },
  preview: {
    // Cloudflare quick tunnels rewrite Host; allow any host so public demos work.
    allowedHosts: true,
  },
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
