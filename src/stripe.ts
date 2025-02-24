import Stripe from 'stripe';
import Subscription from './services/subscription';
import { stripeIntegrationCrud } from './services/stripe';

export default {
	async fetch(request: Request, env: Env) {
		try {
			const signature = request.headers.get('stripe-signature') ?? '';
			if (!signature) {
				return new Response('', {
					status: 400,
				});
			}
			const body = await request.text();

			// parametrize
			// /v1/stripe/${backmeshUid}/${stripeId}
			const requestUrl = new URL(request.url);
			const parts = requestUrl.pathname.split('/').filter((part) => part);
			const backmeshUid = parts.at(2);
			const stripeId = parts.at(3);
			let stripeKey, serviceAccount, stripeWebhookSecret, stripeIntegration;
			if (backmeshUid === undefined || stripeId === undefined) {
				stripeKey = env.STRIPE_KEY;
				serviceAccount = env.BACKMESH_FIREBASE_SERVICE_ACCOUNT;
				stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET;
			}	else if (backmeshUid !== null && stripeId !== null) {
				stripeIntegration = await stripeIntegrationCrud.getAdmin(env, backmeshUid!, stripeId!);
				stripeWebhookSecret = stripeIntegration.webhookSecret;
				stripeKey = stripeIntegration.stripePrivateKey;
			} else {
				throw new TypeError("Invalid pathname");
			}

			const stripe = new Stripe(stripeKey, {
				httpClient: Stripe.createFetchHttpClient()
			});
			const event = await stripe.webhooks.constructEventAsync(
				body,
				signature,
				stripeWebhookSecret
			);

			let session, subscription, authUserId;
			console.log(event.type);
			switch(event.type) {
				// case 'customer.subscription.created':
				case 'customer.subscription.updated':
				case 'customer.subscription.deleted':
					subscription = event.data.object;
					authUserId = subscription.metadata.auth_user_id;
					if (stripeIntegration !== undefined) {
						await Subscription.save(authUserId, stripeIntegration, subscription);
					} else {
						await Subscription.Backmesh.save(serviceAccount!, authUserId, subscription);
					}
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
					subscription = typeof session.subscription === 'string' ? await stripe.subscriptions.retrieve(session.subscription) : session.subscription;
					if (stripeIntegration !== undefined) {
						await Subscription.save(authUserId, stripeIntegration, subscription);
					} else {
						await Subscription.Backmesh.save(serviceAccount!, authUserId, subscription);
					}
						// set auth user id in metadata to use in subsequent webhooks
						// https://docs.stripe.com/api/metadata
					await stripe.subscriptions.update(
						subscription.id,
						{
							metadata: {
								auth_user_id: authUserId
							},
						}
					);
					break;
				default:
					break
			}
			return new Response("", {
				status: 200,
			});
		} catch (err) {
			console.error(err);
			if (err instanceof TypeError) {
				return new Response('Stripe Integration not found', {
					status: 404,
				});
			}
			if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
				return new Response('Invalid Stripe webhook signature', {
					status: 401
				});
			}
			const errorMessage = `⚠️  Webhook handling failed for event. ${err instanceof Error ? err.message : "Internal server error"}`
			return new Response(errorMessage, {
				status: 500,
			});
		}
	},
};
