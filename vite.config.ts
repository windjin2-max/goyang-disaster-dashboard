import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/goyang-disaster-dashboard/',
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
})
