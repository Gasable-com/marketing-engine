import preact from '@preact/preset-vite';
import { defineConfig, loadEnv } from 'vite';

/**
 * In development the token lives in .env.local and is added by this proxy, so
 * it stays on the machine rather than in the bundle. In production nginx does
 * the same job; the browser never sees it either way.
 */
export default defineConfig(({ mode }) => {
  // '.' rather than process.cwd(): vite already runs from the project root,
  // and reaching for `process` here would need @types/node, which is not on
  // this app's dependency list.
  const env = loadEnv(mode, '.', '');
  const engine = env['ENGINE_URL'] ?? 'http://localhost:3000';

  // Served from a sub-path behind a shared domain (/marketing) as often as
  // from the root, and the built asset URLs have to match wherever it lands.
  const base = env['BASE_PATH'] ?? '/';

  return {
    base,
    plugins: [preact()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: engine,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '/internal'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('X-Internal-Token', env['INTERNAL_TOKEN'] ?? '');
            });
          },
        },
      },
    },
    build: { outDir: 'dist', sourcemap: false },
    test: { environment: 'node', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'] },
  };
});
