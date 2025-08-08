import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: './', // Important for Electron file:// protocol
  build: {
    outDir: 'dist-react',
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  // Electron-specific optimizations
  define: {
    global: 'globalThis'
  }
})