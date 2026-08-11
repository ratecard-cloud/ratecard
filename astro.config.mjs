import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://ratecard.cloud',
  integrations: [sitemap()],
  vite: { plugins: [tailwind()] },
  build: { inlineStylesheets: 'auto' },
  compressHTML: true,
});
