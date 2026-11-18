// @ts-check
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';
import { defineConfig } from 'astro/config';
import { sidebar } from './src/sidebar.mjs';

// The site's one address: canonical URLs, the sitemap and the OG image.
export const SITE_URL = 'https://backmesh.com';

export default defineConfig({
  site: SITE_URL,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'backmesh',
      description:
        'Self-hosted GitHub Actions runners on spot VMs in your own AWS, GCP and Azure accounts.',
      logo: {
        light: './public/brand/lockup-light.svg',
        dark: './public/brand/lockup-dark.svg',
        replacesTitle: true,
      },
      favicon: '/brand/favicon.svg',
      head: [
        {
          tag: 'link',
          attrs: { rel: 'icon', href: '/brand/favicon.ico', sizes: '48x48' },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'apple-touch-icon',
            href: '/brand/apple-touch-icon.png',
          },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: `${SITE_URL}/brand/og.png` },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
      ],
      customCss: ['./src/styles/fonts.css', './src/styles/starlight.css'],
      sidebar,
      // The blog at /blog/: post previews, dates and tags, in the docs'
      // theme. No header link or RSS icon, so docs pages look as before.
      plugins: [
        starlightBlog({
          title: 'Blog',
          prefix: 'blog',
          navigation: 'none',
          rss: false,
          postCount: 10,
          recentPostCount: 10,
          metrics: { readingTime: true },
          authors: {
            backmesh: { name: 'backmesh', url: 'https://backmesh.com/' },
          },
        }),
      ],
      pagination: false,
      credits: false,
    }),
  ],
});
