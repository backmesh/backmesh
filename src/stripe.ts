import Stripe from 'stripe';

import kv, { PlanType } from './services/kv';

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
			// https://docs.stripe.com/api/payment_intents/object
			let session = null;
			switch(event.type) {
					case 'checkout.session.completed':
						session = event.data.object;
						if (!session.client_reference_id) {
							throw new Error("Missing client_reference_id");
						}
						if (session.customer === null) {
							throw new Error("Missing customer");
						}
						const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
						await kv.newPlan(env, session.client_reference_id, {customerId, type: PlanType.Starter});

						// Get the plan ID from the session line items
						const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
						const productId = lineItems.data[0]?.price?.product;
						if (!productId) {
							throw new Error("Missing product ID");
						}
						// Set custom claims in Firebase Auth
						const firebaseApiUrl = `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${env.BACKMESH_FIREBASE_KEY}`;
						const customClaims = {
							[`${session.id}`]: {
								date: new Date().toISOString(),
								subscriptionId: session.subscription,
								customerId: customerId,
								productIds: lineItems.data.map(l => l?.price?.product),
							},
						};
						const response = await fetch(firebaseApiUrl, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								localId: session.client_reference_id,
								customAttributes: JSON.stringify(customClaims)
							})
						});

						if (!response.ok) {
							console.error(`Failed to set custom claims: ${await response.text()}`);
						}

						break;
					default:
							break
			}
			return new Response("", {
				status: 200,
			});
		} catch (err) {
			const errorMessage = `⚠️  Webhook signature verification failed. ${err instanceof Error ? err.message : "Internal server error"}`
			console.log(errorMessage);
			return new Response(errorMessage, {
				status: 400,
			});
		}
	},
};
