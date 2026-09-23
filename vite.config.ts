import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.venv/**', '**/.data/**'] },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.data/**', '**/.venv/**'] },
    proxy: {
      '/api': 'http://127.0.0.1:4310',
      '/artifacts': 'http://127.0.0.1:4310',
      '/demo': 'http://127.0.0.1:4310',
    },
  },
});
