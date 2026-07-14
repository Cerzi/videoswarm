import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'tests/electron/**'],
    globals: true,
    setupFiles: './vitest.setup.js',
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      include: [
        'main/**/*.js',
        'src/**/*.{js,jsx}',
      ],
      exclude: [
        '**/*.test.{js,jsx,mjs,cjs}',
        '**/__tests__/**',
        'src/main.jsx',
      ],
      thresholds: {
        statements: 75,
        branches: 68,
        functions: 75,
        lines: 75,
      },
    }
  },
});
