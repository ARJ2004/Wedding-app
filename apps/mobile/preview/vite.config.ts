import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

const root = path.resolve(__dirname, '../../..');
const pkg = (name: string) => path.join(root, 'packages', name, 'src');

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  define: {
    __DEV__: 'true',
    'process.env.NODE_ENV': JSON.stringify('development'),
    global: 'globalThis',
  },
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      { find: '@mehfil/design-tokens', replacement: pkg('design-tokens') },
      { find: '@mehfil/domain', replacement: pkg('domain') },
      { find: '@mehfil/i18n', replacement: pkg('i18n') },
      { find: '@mehfil/api-client', replacement: pkg('api-client') },
    ],
  },
  optimizeDeps: {
    esbuildOptions: { resolveExtensions: ['.web.js', '.js', '.ts', '.tsx'], loader: { '.js': 'jsx' } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/v1': 'http://localhost:4000' },
  },
});
