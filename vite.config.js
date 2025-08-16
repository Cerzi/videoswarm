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
      },
      // Add watch exclusions for build
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
    // ADD FILE WATCHING OPTIMIZATIONS TO FIX EMFILE ERROR
    watch: {
      // Aggressively ignore directories to reduce file watching
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
        // Ignore common video directories that might be in your workspace
        '**/videos/**',
        '**/media/**',
        '**/assets/videos/**',
        // Ignore other common large directories
        '**/.vscode/**',
        '**/.idea/**',
        '**/Android/**',
        '**/ios/**',
        // Add any specific video folders you might have
        '**/output/**',
        '**/generated/**',
        '**/ComfyUI/**'
      ],
      // Use polling as a fallback for file watching issues
      usePolling: process.env.VITE_USE_POLLING === 'true',
      interval: 1000,
      binaryInterval: 1000,
      // Disable deep watching for performance
      depth: 3
    },
    hmr: {
      overlay: true,
      // Reduce HMR overhead
      timeout: 30000
    }
  },
  // Electron-specific optimizations
  define: {
    global: 'globalThis'
  },
  // Optimize for development
  optimizeDeps: {
    include: ['react', 'react-dom'],
    exclude: ['electron']
  }
})