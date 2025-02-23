import Stripe from 'stripe';
import Firebase from './services/gateways/firebase';
import Subscription from './services/subscription';
import { stripeWebhookCrud } from './services/webhook';
import { AuthProviderType } from './services/repos/models';

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
			let stripeKey, serviceAccount, stripeWebhookSecret;
			if (backmeshUid === null || stripeId === null) {
				stripeKey = env.STRIPE_KEY;
				serviceAccount = env.BACKMESH_FIREBASE_SERVICE_ACCOUNT;
				stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET;
			}	else if (backmeshUid !== null && stripeId !== null) {
				const stripeWebhook = await stripeWebhookCrud.getAdmin(env, backmeshUid!, stripeId!);
				stripeWebhookSecret = stripeWebhook.webhookSecret;
				if (stripeWebhook.authType === AuthProviderType.FIREBASE) {
					stripeKey = stripeWebhook.stripePrivateKey;
					serviceAccount = stripeWebhook.authPrivateKey;
				} else {
					throw new Error("Unsupported auth provider");
				}
			} else {
				throw new Error("Invalid pathname");
			}

			const stripe = new Stripe(stripeKey, {
				httpClient: Stripe.createFetchHttpClient()
			});
			const event = await stripe.webhooks.constructEventAsync(
				body,
				signature,
				stripeWebhookSecret
			);

			let session, subscription, authUserId, existingClaims, updatedClaims;
			console.log(event.type);
			switch(event.type) {
				// case 'customer.subscription.created':
				case 'customer.subscription.updated':
				case 'customer.subscription.deleted':
					subscription = event.data.object;
					authUserId = subscription.metadata.auth_user_id;
					existingClaims = await Firebase.Admin.getClaims(serviceAccount, authUserId);
					updatedClaims = Subscription.updateClaims(existingClaims!, subscription);
					await Firebase.Admin.setClaims(serviceAccount, authUserId, updatedClaims);
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
					existingClaims = await Firebase.Admin.getClaims(serviceAccount, authUserId);
					updatedClaims = Subscription.updateClaims(existingClaims!, subscription);
					await Firebase.Admin.setClaims(serviceAccount, authUserId, updatedClaims);
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
			const errorMessage = `⚠️  Webhook handling failed for event. ${err instanceof Error ? err.message : "Internal server error"}`
			console.log(errorMessage);
			return new Response(errorMessage, {
				status: 400,
			});
		}
	},
};
