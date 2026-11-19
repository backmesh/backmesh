// /llms-full.txt: every docs page in the sidebar's order, as one Markdown
// file for AI assistants, with the site's links made absolute.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SUMMARY } from '../about';
import { sidebar } from '../sidebar.mjs';

export const GET: APIRoute = async ({ site }) => {
  const docs = new Map((await getCollection('docs')).map((d) => [d.id, d]));
  const pages = sidebar
    .flatMap(({ items }) => items)
    .map((id) => {
      const { data, body = '' } = docs.get(id)!;
      const absolute = body
        // MDX pages' imports and components aren't Markdown readers can use.
        .replace(/^import .*$\n?/gm, '')
        .replace(/^<[A-Z]\w* \/>$\n?/gm, '')
        .replaceAll('](/', `](${site!.origin}/`)
        .replaceAll('](#', `](${site!.origin}/${id}/#`);
      return `# ${data.title}\n\nSource: ${new URL(`/${id}/`, site).href}\n\n${absolute.trim()}`;
    });
  const text = `# backmesh\n\n> ${SUMMARY}\n\n${pages.join('\n\n')}\n`;
  return new Response(text, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
