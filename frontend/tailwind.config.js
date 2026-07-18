/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy:   { DEFAULT: '#0A2547', 50: '#E8EDF4', 100: '#C5D1E4', 200: '#8DA5C9', 300: '#5579AE', 400: '#2D5490', 500: '#0A2547', 600: '#081E3A', 700: '#06162C', 800: '#040F1E', 900: '#020710' },
        royal:  { DEFAULT: '#1565C0', 50: '#E3EFFD', 100: '#BAD5FA', 200: '#71AAF5', 300: '#3586EF', 400: '#1565C0', 500: '#0D4E9A', 600: '#0A3D7A', 700: '#072D59', 800: '#051E3B', 900: '#020F1E' },
        amber:  { DEFAULT: '#F59E0B', 50: '#FEF9EC', 600: '#D97706' },
        slate:  { 50: '#F8FAFC', 100: '#F1F5F9', 200: '#E2E8F0', 300: '#CBD5E1', 400: '#94A3B8', 500: '#64748B', 600: '#475569', 700: '#334155', 800: '#1E293B', 900: '#0F172A' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        card:  '0 1px 3px 0 rgba(10,37,71,0.08), 0 1px 2px -1px rgba(10,37,71,0.06)',
        panel: '0 4px 24px 0 rgba(10,37,71,0.10)',
      },
    },
  },
  plugins: [],
}
