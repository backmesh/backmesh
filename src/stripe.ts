import Stripe from 'stripe';

import kv, { PlanType } from './services/kv';
import { AdminAuthApiClient, ServiceAccountCredential } from 'firebase-auth-cloudflare-workers';

async function saveUserClaims(serviceAccount: string, authUserId: string, subscription: Stripe.Subscription) {
	const credential = new ServiceAccountCredential(serviceAccount);
	const auth = AdminAuthApiClient.getOrInitialize(
		credential.projectId,
		credential
	);
	const userRecord = await auth.getAccountInfoByUid(authUserId);
	const existingClaims = userRecord.customClaims || {};
	const products = subscription.items.data.map(item => `${item.quantity}x${item.price.product}`);
	// Merge new claims with existing ones
	const stripe_subs = existingClaims.stripe_subs || {};
	stripe_subs[subscription.id] = {
		// https://docs.stripe.com/api/subscriptions/object#subscription_object-status
		status: subscription.status,
		prods: products
	};
	/*
	{
		'stripe_subs': {
			'sub_1QuhibIz61apsROqSAQ1LoSU': {
				'status': 'trialing',
				'prods': ['1xprod_RaNeaDpniWdiK4'
			}
		}
	}
	*/
	await auth.setCustomUserClaims(authUserId, {
		...existingClaims,
		stripe_subs,
	});
}

export default {
	async fetch(request: Request, env: Env) {
		const stripe = new Stripe(env.STRIPE_KEY, {
			httpClient: Stripe.createFetchHttpClient()
		});
		try {
			const signature = request.headers.get('stripe-signature') ?? '';
			if (!signature) {
				return new Response('', {
					status: 400,
				});
			}
			const body = await request.text();
			const event = await stripe.webhooks.constructEventAsync(
				body,
				signature,
				env.STRIPE_WEBHOOK_SECRET
			);

			let session, subscription, customerId, authUserId;
			console.log(event.type);
			switch(event.type) {
				// case 'customer.subscription.created':
				case 'customer.subscription.updated':
				case 'customer.subscription.deleted':
					subscription = event.data.object;
					// customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
					authUserId = subscription.metadata.auth_user_id;
					await saveUserClaims(env.BACKMESH_FIREBASE_SERVICE_ACCOUNT, authUserId, subscription);
					break;

				case 'checkout.session.completed':
					session = event.data.object;
					if (session.client_reference_id === null) {
						throw new Error("Missing client_reference_id");
					}
					if (session.customer === null) {
						throw new Error("Missing customer");
					}
					if (session.subscription === null) {
						throw new Error("Missing subscription");
					}
					authUserId = session.client_reference_id;
					// customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
					subscription = typeof session.subscription === 'string' ? await stripe.subscriptions.retrieve(session.subscription) : session.subscription;
					await saveUserClaims(env.BACKMESH_FIREBASE_SERVICE_ACCOUNT, authUserId, subscription!);
					// set auth user id in metadata to use in webhooks later on
					// https://docs.stripe.com/api/metadata
					await stripe.subscriptions.update(
						subscription.id,
						{
							metadata: {
								auth_user_id: authUserId
							},
						}
					);
					// TODO remove
					await kv.newPlan(env, authUserId, {customerId, type: PlanType.Starter});
					break;
				default:
						break
			}
			return new Response("", {
				status: 200,
			});
		} catch (err) {
			const errorMessage = `⚠️  Webhook handling failed for event. ${err instanceof Error ? err.message : "Internal server error"}`
			console.log(errorMessage);
			return new Response(errorMessage, {
				status: 400,
			});
		}
	},
};
