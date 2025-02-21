import auth from './services/auth';
import Firebase from './services/gateways/firebase';
import kv from './services/kv';
import Subscription from './services/subscription';

async function handleRequest(callback: () => Promise<any>): Promise<Response> {
	try {
		const result = await callback();
		return new Response(result instanceof Object ? JSON.stringify(result) : 'OK', {
			status: 200,
		});
	} catch (error: any) {
		console.error(error);
		const status = error instanceof TypeError ? 400 : 500;
		return new Response(error.message ?? 'Unknown error', { status });
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const authHeader = auth.getAuthHeader(request, 'Authorization');
		if (authHeader === null)
			return new Response('Missing or invalid Authorization header', {
				status: 401,
			});
		const jwtUid = await Firebase.getUid(
			authHeader.extractedJwt,
			env.BACKMESH_FIREBASE_KEY,
		);
		if (jwtUid === null) return new Response('Invalid token', { status: 401 });
		const requestUrl = new URL(request.url);
		const parts = requestUrl.pathname.split('/').filter((part) => part);

		// /v1/crud/${backmeshUid}/${apiProxyId}
		// PUT and DELETE need the id
		// GET will list if it does not get it
		const backmeshUid = parts.at(2);
		if (jwtUid !== backmeshUid) {
			return new Response('Invalid token', { status: 401 });
		}
		// return 402, payment required, if billing is enabled and user has not paid
		if (env.STRIPE_KEY && request.method !== 'GET') {
			const claims = await Firebase.getClaims(authHeader.extractedJwt, env.BACKMESH_FIREBASE_KEY);
			const isValid = Subscription.hasValidSubscription(claims);
			if (!isValid) {
				return new Response('Subscription required', { status: 402 });
			}
		}
		const proxyId = parts.at(3);
		const isSummary = parts.at(4) === 'summary';
		switch (request.method) {
			case 'POST':
				if (!request.body) {
					return new Response('No body in request', { status: 400 });
				}
				return handleRequest(async () =>
					kv.newApiProxy(env, requestUrl.origin, backmeshUid, await request.json()),
				);

			case 'PUT':
				if (proxyId === undefined) {
					return new Response('Invalid pathname', { status: 400 });
				}
				if (!request.body) {
					return new Response('No body in request', { status: 400 });
				}
				return handleRequest(async () =>
					kv.editApiProxy(env, backmeshUid, proxyId!, await request.json()),
				);

			case 'GET':
				return handleRequest(async () => {
					if (isSummary) {
						if (proxyId === undefined) {
							return new Response('Invalid pathname', { status: 400 });
						}
						return kv.getProxyExchangeSummaries(env, backmeshUid, proxyId);
					}
					return proxyId === undefined
						? kv.getAllApiProxies(env, backmeshUid)
						: kv.getApiProxy(env, backmeshUid, proxyId!);
				});

			case 'DELETE':
				if (proxyId === undefined) {
					return new Response('Invalid pathname', { status: 400 });
				}
				return handleRequest(async () => kv.delApiProxy(env, backmeshUid, proxyId!));

			default:
				return new Response('Not Found', { status: 404 });
		}
	},
};
