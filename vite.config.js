import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  plugins: [react()],
  base: './', // Important for Electron file:// protocol
  build: {
    outDir: 'dist-react',
    assetsDir: 'assets',
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
      // Note: rollupOptions.watch is ignored in production builds; that's fine.
      watch: {
        exclude: [
          'node_modules/**',
          '.git/**',
          'dist/**',
          'dist-react/**'
        ]
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/dist-react/**',
        '**/build/**',
        '**/coverage/**',
        '**/.cache/**',
        '**/tmp/**',
        '**/temp/**',
        '**/.electron/**',
        '**/logs/**',
        '**/*.log',
        '**/videos/**',
        '**/media/**',
        '**/assets/videos/**',
        '**/.vscode/**',
        '**/.idea/**',
        '**/Android/**',
        '**/ios/**',
        '**/output/**',
        '**/generated/**',
        '**/ComfyUI/**'
      ],
      usePolling: process.env.VITE_USE_POLLING === 'true',
      interval: 1000,
      binaryInterval: 1000,
      depth: 3
    },
    hmr: { overlay: true, timeout: 30000 }
  },
  define: {
    global: 'globalThis',
    // inject the package.json version
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
    exclude: ['electron']
  }
})
