import { defineConfig } from '@playwright/test'

// Web viewer tests: run against a live `pcbstudio web` (PCBSTUDIO_WEB_URL).
export default defineConfig({
  testDir: './e2e-web',
  timeout: 60_000,
  workers: 1,
  reporter: 'list'
})
