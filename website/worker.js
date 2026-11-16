// Serves the static site. It runs before the assets, so it can send
// www.backmesh.com to the apex, /pricing to the landing page's pricing,
// serve install.sh as text so a browser shows it, and retire the old site's
// other paths.
const RETIRED = /^\/(docs|blog|app|firebase-jwt|supabase-jwt)(\/|$)/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
    if (RETIRED.test(url.pathname)) {
      return Response.redirect(new URL('/', url).href, 301);
    }
    const response = await env.ASSETS.fetch(request);
    // The assets add a page's trailing slash with a 307; a 301 tells search
    // engines the slashed URL is the page's one address.
    if (response.status === 307) {
      const location = response.headers.get('location');
      if (location) return Response.redirect(new URL(location, url).href, 301);
    }
    if (url.pathname === '/install.sh' && response.ok) {
      const text = new Response(response.body, response);
      text.headers.set('content-type', 'text/plain; charset=utf-8');
      return text;
    }
    return response;
  },
};
