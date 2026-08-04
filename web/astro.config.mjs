// @ts-check
import { defineConfig } from 'astro/config';

// `site` drives canonical URLs and the sitemap. Replace with the real
// production domain once it is connected in the Vercel project settings.
export default defineConfig({
  site: 'https://sigpi.dev',
  output: 'static',
});
