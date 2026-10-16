import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));
const devApiTarget = `http://127.0.0.1:${process.env.PORT ?? '8070'}`;

export default defineConfig({
  root: webRoot,
  publicDir: 'public',
  // JSX is compiled by Vite's built-in transformer for Preact (no Babel needed).
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: devApiTarget, changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['server/**/*.test.ts', 'web/src/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    pool: 'forks',
  },
});
