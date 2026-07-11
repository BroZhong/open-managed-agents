import { defineConfig } from 'vitest/config'
import path from 'path'

// Vitest-only config. Kept separate from vite.config.ts so the production
// build's `tsc -b` (which typechecks vite.config.ts) is unaffected by the
// vitest/vite plugin type surface.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
