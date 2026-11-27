// The site's Worker (website/worker.ts): it runs before the static assets,
// so a rule here can hide a page the build serves. The old backmesh site's
// paths are gone for good (410) unless this site now serves a page there.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import worker from '../../website/worker.ts';

const POSTS = readdirSync(
  join(import.meta.dirname, '../../website/src/content/docs/blog'),
)
  .filter((f) => f.endsWith('.md'))
  .map((f) => `/blog/${f.slice(0, -3)}/`);
const PAGES = new Set([
  '/',
  '/blog/',
  '/blog/tags/cost/',
  '/blog/tags/showcase/',
  '/firebase-jwt/',
  '/supabase-jwt/',
  ...POSTS,
]);

// Cloudflare's assets with not_found_handling "404-page": a page's address
// without its trailing slash gets a 307, anything else not built a 404.
const ASSETS = {
  async fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (PAGES.has(pathname)) return new Response('page');
    if (PAGES.has(`${pathname}/`)) {
      return new Response(null, {
        status: 307,
        headers: { location: `${pathname}/` },
      });
    }
    return new Response('not found page', { status: 404 });
  },
};

const get = (path: string, host = 'backmesh.com') =>
  worker.fetch(new Request(`https://${host}${path}`), { ASSETS });

describe('the site Worker', () => {
  it('serves every blog post', async () => {
    expect(POSTS.length).toBeGreaterThan(0);
    for (const path of [
      '/blog/',
      '/blog/tags/cost/',
      '/blog/tags/showcase/',
      ...POSTS,
    ]) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it.each(['/firebase-jwt/', '/supabase-jwt/'])(
    'serves the JWT tool at %s',
    async (path) => {
      expect((await get(path)).status).toBe(200);
    },
  );

  it.each([
    '/docs/selfhost',
    '/docs/Tutorials/supabase+openai',
    '/blog/opensource',
    '/blog/archive',
    '/blog/tags/llm',
    '/app',
  ])('retires the old site’s %s with a 410', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(410);
    expect(await res.text()).toBe('not found page');
  });

  it('keeps a 404 for other paths', async () => {
    expect((await get('/nope')).status).toBe(404);
  });

  it.each([
    [
      '/blog/backmesh-vs-runs-on',
      'https://backmesh.com/blog/backmesh-vs-runs-on/',
    ],
    ['/supabase-jwt', 'https://backmesh.com/supabase-jwt/'],
    ['/pricing', 'https://backmesh.com/#pricing'],
    ['/docs', 'https://backmesh.com/install/'],
    ['/docs/', 'https://backmesh.com/install/'],
    ['/sitemap.xml', 'https://backmesh.com/sitemap-index.xml'],
  ])('sends %s to %s with a 301', async (path, location) => {
    const res = await get(path);
    expect([res.status, res.headers.get('location')]).toEqual([301, location]);
  });

  it('sends www to the apex with a 301', async () => {
    const res = await get('/blog/', 'www.backmesh.com');
    expect([res.status, res.headers.get('location')]).toEqual([
      301,
      'https://backmesh.com/blog/',
    ]);
  });
});
