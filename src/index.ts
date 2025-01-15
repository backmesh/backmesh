import crud from './crud';
import proxy from './proxy';
import stripe from './stripe';

// Reference: https://developers.cloudflare.com/workers/examples/cors-header-proxy
// https://stackoverflow.com/questions/66486610/how-to-set-cors-in-cloudflare-workers
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,DELETE,OPTIONS',
	'Access-Control-Max-Age': '86400',
};
function handleOptions(request: Request) {
	// Make sure the necessary headers are present
	// for this to be a valid pre-flight request
	let headers = request.headers;
	if (
		headers.get('Origin') !== null &&
		headers.get('Access-Control-Request-Method') !== null &&
		headers.get('Access-Control-Request-Headers') !== null
	) {
		// Handle CORS pre-flight request.
		// If you want to check or reject the requested method + headers
		// you can do that here.
		let respHeaders = {
			...corsHeaders,
			// Allow all future content Request headers to go back to browser
			// such as Authorization (Bearer) or X-Client-Name-Version
			'Access-Control-Allow-Headers':
				request.headers.get('Access-Control-Request-Headers') || '',
		};
		return new Response(null, {
			headers: respHeaders,
		});
	} else {
		// Handle standard OPTIONS request.
		// If you want to allow other HTTP Methods, you can do that here.
		return new Response(null, {
			headers: {
				Allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
			},
		});
	}
}

export default {
	async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}
		const url = new URL(request.url);
		const path = url.pathname;
		let resp;
		if (path.startsWith('/v1/crud')) {
			resp = await crud.fetch(request, env);
		} else if (path.startsWith('/v1/stripe')) {
			resp = await stripe.fetch(request, env);
		} else if (path.startsWith('/v1/proxy')) {
			const proxyReq = await proxy.validate(request, env);
			const start = performance.now();
			const proxyResp = await proxy.fetch(proxyReq, env);
			const end = performance.now();
			const timing = end - start;
			// log request without blocking response if request was valid
			ctx.waitUntil(proxy.postprocessing(proxyReq, proxyResp, start, timing, env));
			resp = proxyResp.response;
		}
		if (resp === undefined) return new Response('Not Found', { status: 404 });
		resp.headers.set('Access-Control-Allow-Origin', '*');
		resp.headers.set(
			'Access-Control-Allow-Methods',
			'GET, POST, PUT, DELETE, OPTIONS',
		);
		return resp;
	},
};
