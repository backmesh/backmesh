// Serves the static site. It runs before the assets, so it can send
// www.backmesh.com to the apex, the old llmcomp.backmesh.com to /llmcomp/, /pricing to the landing page's pricing, the
// old docs' index to the install guide, serve install.sh as text so a browser shows it, and retire the old site's
// other paths: a 410 where this site has no page, so search engines drop
// them. This site's own pages there, such as the blog, are served first.
const RETIRED = /^\/(docs|blog|app|firebase-jwt|supabase-jwt)(\/|$)/;

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'llmcomp.backmesh.com') {
      return Response.redirect(
        `https://backmesh.com/llmcomp/${url.search}`,
        301,
      );
    }
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.href, 301);
    }
    // Starlight writes the sitemap as /sitemap-index.xml; crawlers and
    // people look for /sitemap.xml.
    if (url.pathname === '/sitemap.xml') {
      return Response.redirect(new URL('/sitemap-index.xml', url).href, 301);
    }
    if (/^\/pricing(\/|$)/.test(url.pathname)) {
      return Response.redirect(new URL('/#pricing', url).href, 301);
    }
    if (/^\/docs\/?$/.test(url.pathname)) {
      return Response.redirect(new URL('/install/', url).href, 301);
    }
    const response = await env.ASSETS.fetch(request);
    // The assets add a page's trailing slash with a 307; a 301 tells search
    // engines the slashed URL is the page's one address.
    if (response.status === 307) {
      const location = response.headers.get('location');
      if (location) return Response.redirect(new URL(location, url).href, 301);
    }
    if (response.status === 404 && RETIRED.test(url.pathname)) {
      return new Response(response.body, {
        status: 410,
        headers: response.headers,
      });
    }
    if (url.pathname === '/install.sh' && response.ok) {
      const text = new Response(response.body, response);
      text.headers.set('content-type', 'text/plain; charset=utf-8');
      return text;
    }
    return response;
  },
};
