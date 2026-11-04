// Web viewer build (read-only PWA served by `pcbstudio web`): the same renderer, without Electron.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(__dirname, 'web-public'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out-web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000
  }
})
