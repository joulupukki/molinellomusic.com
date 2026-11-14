// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.molinellomusic.com',

  redirects: {
    '/microphones/milton': '/about#past-builds',
    '/chester/assets/1-position-down.wav': 'https://pub-afb386f68d8745a184d17ac1f48d3723.r2.dev/chester/1-position-down.wav',
    '/chester/assets/2-position-up.wav': 'https://pub-afb386f68d8745a184d17ac1f48d3723.r2.dev/chester/2-position-up.wav',
    '/chester/assets/3-position-facing-down-45.wav': 'https://pub-afb386f68d8745a184d17ac1f48d3723.r2.dev/chester/3-position-facing-down-45.wav',
    '/chester/assets/4-position-facing-up-45.wav': 'https://pub-afb386f68d8745a184d17ac1f48d3723.r2.dev/chester/4-position-facing-up-45.wav',
    '/chester/assets/5-position-facing-up-180.wav': 'https://pub-afb386f68d8745a184d17ac1f48d3723.r2.dev/chester/5-position-facing-up-180.wav'
  },

  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [sitemap({
    filter: (page) => !page.includes('/pedals/gamma-preq')
  })]
});