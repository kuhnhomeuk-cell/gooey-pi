import { cpus } from 'node:os'
import { defineConfig } from '@playwright/test'

// Each spec launches its own Electron + temp fixture, so files can share the
// worker pool. Sessions stay in the same pool; they do not share app state.
const workers = Math.max(2, Math.min(4, Math.floor((cpus().length || 2) / 2)))

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.spec.ts',
  timeout: 75_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers,
  // Electron can occasionally fail to create its first macOS window even after
  // the child launches. A retry gets a fresh Playwright worker/process while
  // deterministic product failures still fail twice.
  retries: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
