import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://ratecard.cloud',
  // JSON endpoints are for programs, not search results.
  integrations: [sitemap({ filter: (page) => !page.includes('/api/') })],
  vite: { plugins: [tailwind()] },
  build: { inlineStylesheets: 'auto' },
  compressHTML: true,
});
