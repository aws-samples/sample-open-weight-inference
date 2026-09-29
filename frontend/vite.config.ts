import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    // Opt-in loopback proxy for authenticating and testing the actual coordinator.
    // No auth bypass, public listener, or caller-selected proxy destination.
    proxy: process.env.VITE_EDDIE_LOCAL_RUNTIME === '1' ? {
      '/_eddie/invocations': {
        target: 'http://127.0.0.1:8080',
        rewrite: () => '/invocations',
      },
    } : undefined,
  },
  define: {
    // amazon-cognito-identity-js reaches for the Node `global` object.
    global: 'globalThis',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Function form: Vite 8 / Rolldown does not accept the object map.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          // Cloudscape dominates the bundle and changes rarely, so it is
          // cached independently of application code.
          if (id.includes('@cloudscape-design')) return 'cloudscape';
          if (id.includes('amazon-cognito-identity-js')) return 'auth';
          if (
            /node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(
              id
            )
          ) {
            return 'react';
          }
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
  },
});
