import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // The audio worklet is small enough that Vite would inline it as a data: URI,
    // which our CSP blocks — addModule() needs it to stay a real same-origin file.
    build: { assetsInlineLimit: 0 },
    plugins: [react()]
  }
})
