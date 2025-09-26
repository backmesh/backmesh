import auth from './services/auth';
import Subscription from './services/subscription';
import posthog from './services/gateways/posthog';
import { ProxyExchangeSummary } from './services/analytics';
import { apiProxyCrud } from './services/proxy';
import { stripeIntegrationCrud } from './services/stripe';

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
		const jwtUid = await auth.Backmesh.getUid(
			env.BACKMESH_FIREBASE_KEY,
			authHeader.extractedJwt,
		);
		if (jwtUid === null) return new Response('Invalid token', { status: 401 });
		const requestUrl = new URL(request.url);
		const parts = requestUrl.pathname.split('/').filter((part) => part);

		// /v1/crud/${resourceType}/${backmeshUid}/${resourceId}
		const resourceType = parts.at(2); // 'proxy' or 'stripe'
		const backmeshUid = parts.at(3);
		const resourceId = parts.at(4);

		if (jwtUid !== backmeshUid) {
			return new Response('Invalid token', { status: 401 });
		}
		// return 402, payment required, if billing is enabled and user has not paid
		if (env.STRIPE_KEY && env.STRIPE_KEY != env.TEST_STRIPE_KEY && request.method !== 'GET') {
			const isValid = await Subscription.Backmesh.isValid(env.BACKMESH_FIREBASE_KEY, authHeader.extractedJwt);
			if (!isValid) {
				return new Response('Subscription required', { status: 402 });
			}
		}

		switch (resourceType) {
			case 'proxy':
				const isSummary = parts.at(5) === 'summary';
				return handleProxyRequest(request, env, backmeshUid, resourceId, isSummary);
			case 'stripe':
				const subscriptions = parts.at(5) === 'subscriptions';
				return handleStripeWebhook(request, env, backmeshUid, resourceId, subscriptions);
			default:
				return new Response('Invalid resource type', { status: 400 });
		}
	},
};

async function handleStripeWebhook(
	request: Request, 
	env: Env, 
	backmeshUid: string, 
	webhookId?: string,
	subscriptions?: boolean,
): Promise<Response> {
	switch (request.method) {
		case 'POST':
			if (!request.body) {
				return new Response('No body in request', { status: 400 });
			}
			return handleRequest(async () =>
				stripeIntegrationCrud.create(env, backmeshUid, await request.json()),
			);

		case 'PUT':
			if (webhookId === undefined) {
				return new Response('Invalid pathname', { status: 400 });
			}
			if (!request.body) {
				return new Response('No body in request', { status: 400 });
			}
			return handleRequest(async () =>
				stripeIntegrationCrud.edit(env, backmeshUid, webhookId!, await request.json()),
			);

		case 'GET':
			return handleRequest(async () => {
				if (subscriptions && webhookId !== undefined) {
					// get all subscriptions for stripe integration
					const integration = await stripeIntegrationCrud.getAdmin(env, backmeshUid, webhookId!);
					return await Subscription.getAll(integration.authPrivateKey, integration);
				}
				if (webhookId !== undefined) {
					return new Response('Invalid pathname', { status: 400 });
				}
				return stripeIntegrationCrud.getAll(env, backmeshUid);
			});

		case 'DELETE':
			if (webhookId === undefined) {
				return new Response('Invalid pathname', { status: 400 });
			}
			return handleRequest(async () => stripeIntegrationCrud.delete(env, backmeshUid, webhookId!));

		default:
			return new Response('Not Found', { status: 404 });
	}
}


async function handleProxyRequest(
	request: Request, 
	env: Env, 
	backmeshUid: string, 
	proxyId?: string,
	isSummary?: boolean
): Promise<Response> {
	switch (request.method) {
		case 'POST':
			if (!request.body) {
				return new Response('No body in request', { status: 400 });
			}
			const requestUrl = new URL(request.url);
			return handleRequest(async () => {
				const proxy = await apiProxyCrud.create(env, requestUrl.origin, backmeshUid, await request.json());
				await posthog.captureNewProxy(backmeshUid, proxy.id!, env);
				return proxy;
			});

		case 'PUT':
			if (proxyId === undefined) {
				return new Response('Invalid pathname', { status: 400 });
			}
			if (!request.body) {
				return new Response('No body in request', { status: 400 });
			}
			return handleRequest(async () => {
				const proxy = await apiProxyCrud.edit(env, backmeshUid, proxyId!, await request.json());
				await posthog.captureEditProxy(backmeshUid, proxyId!, env);
				return proxy;
			});

		case 'GET':
			return handleRequest(async () => {
				if (isSummary) {
					if (proxyId === undefined) {
						return new Response('Invalid pathname', { status: 400 });
					}
					return ProxyExchangeSummary.analyticsPerUser(env, backmeshUid, proxyId);
				}
				return proxyId === undefined
					? apiProxyCrud.getAll(env, backmeshUid)
					: apiProxyCrud.get(env, backmeshUid, proxyId!);
			});

		case 'DELETE':
			if (proxyId === undefined) {
				return new Response('Invalid pathname', { status: 400 });
			}
			return handleRequest(async () => {
				const proxy = await apiProxyCrud.delete(env, backmeshUid, proxyId!);
				await posthog.captureDeleteProxy(backmeshUid, proxyId!, env);
				return proxy;
			});

		default:
			return new Response('Not Found', { status: 404 });
	}
}
