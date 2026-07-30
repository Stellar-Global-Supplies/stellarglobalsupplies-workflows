import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Cloudflare Pages has a 25MB per-file limit — chunk large deps
    rollupOptions: {
      output: {
        manualChunks: {
          vendor:    ['react', 'react-dom', 'react-router-dom'],
          supabase:  ['@supabase/supabase-js'],
          query:     ['@tanstack/react-query'],
          ui:        ['lucide-react', 'react-hot-toast', 'react-markdown'],
        },
      },
    },
  },
})