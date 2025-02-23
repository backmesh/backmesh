import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';

import { AuthProviderType, CustomClaims, SchemaVersion, StripeIntegration } from '../src/services/repos/models';
import { getTokenFromFirebaseKey } from './utils';
import Firebase from '../src/services/gateways/firebase';


const backmeshFirebaseKey = env.BACKMESH_FIREBASE_KEY;
const testUserEmail = env.FIREBASE_TEST_USER_EMAIL;
const testUserId = env.FIREBASE_TEST_USER_ID;
const serviceAccount = env.BACKMESH_FIREBASE_SERVICE_ACCOUNT;
const testUserJwt = await getTokenFromFirebaseKey(
	backmeshFirebaseKey,
	testUserEmail,
	env.TEST_USER_PASS,
);

const stripeKey = env.TEST_STRIPE_KEY;
const stripeWebhookSecret = env.TEST_STRIPE_WEBHOOK_SECRET;

describe('Stripe Integration CRUD Operations', () => {
	let response: Response;
	let webhookId: string;
	let webhookUrl: string;

	const validWebhookInit = {
		webhookSecret: stripeWebhookSecret,
		stripePrivateKey: stripeKey,
		authPrivateKey: serviceAccount,
		authType: AuthProviderType.FIREBASE,
		schemaVersion: SchemaVersion.V1,
	};

	// Add beforeAll to ensure clean state
	beforeAll(async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: JSON.stringify(validWebhookInit),
		});
		expect(response.status).toBe(200);
		const webhook = await response.json() as StripeIntegration;
		expect(webhook.id).toBeDefined();
		expect(webhook.webhookUrl).toBeDefined();
		expect(webhook.webhookUrl).toBe(`https://example.com/v1/stripe/${testUserId}/${webhook.id}`);
		expect(webhook.webhookSecret).toBe('');
		expect(webhook.stripePrivateKey).toBe('');
		expect(webhook.authPrivateKey).toBe('');
		webhookId = webhook.id;
		webhookUrl = webhook.webhookUrl;
	});

	it('fails to create webhook with no token', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/backmeshUid`, {
			method: 'POST',
			headers: {
				Authorization: 'invalid_token',
			},
			body: JSON.stringify(validWebhookInit),
		});
		expect(response.status).toBe(401);
	});

	it('fails to create webhook with invalid uid', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/invalid_uid`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: JSON.stringify(validWebhookInit),
		});
		expect(response.status).toBe(401);
	});

	it('successfully creates a webhook', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: JSON.stringify(validWebhookInit),
		});
		expect(response.status).toBe(200);
		const webhook = await response.json() as StripeIntegration;
		expect(webhook.id).toBeDefined();
		expect(webhook.webhookUrl).toBe(`https://example.com/v1/stripe/${testUserId}/${webhook.id}`);
		expect(webhook.webhookSecret).toBe('');
		expect(webhook.stripePrivateKey).toBe('');
		expect(webhook.authPrivateKey).toBe('');
	});

	it('successfully lists webhooks with webhookUrl', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}`, {
			method: 'GET',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(200);
		const webhooks = await response.json() as StripeIntegration[];
		expect(webhooks.length).toBe(1);
		const foundWebhook = webhooks.find(webhook => webhook.id === webhookId);
		expect(foundWebhook).toBeDefined();
		if (foundWebhook) {
			expect(foundWebhook.webhookUrl).toBe(webhookUrl);
		}
	});

	it('successfully updates a webhook', async () => {
		const updatedWebhook = {
			...validWebhookInit,
			id: webhookId, // Include ID in update
			webhookUrl,
			webhookSecret: 'whsec_updated_secret',
		};

		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/${webhookId}`, {
			method: 'PUT',
			headers: {
				Authorization: testUserJwt,
			},
			body: JSON.stringify(updatedWebhook),
		});
		expect(response.status).toBe(200);
		const webhook = await response.json() as StripeIntegration;
		expect(webhook.webhookSecret).toBe('');
		expect(webhook.stripePrivateKey).toBe('');
		expect(webhook.authPrivateKey).toBe('');
		expect(webhook.webhookUrl).toBe(webhookUrl);
	});

	it('fails to update webhook with invalid id', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/invalid_id`, {
			method: 'PUT',
			headers: {
				Authorization: testUserJwt,
			},
			body: JSON.stringify(validWebhookInit),
		});
		expect(response.status).toBe(400);
	});

	it('fails to update webhook with modified webhookUrl', async () => {
		const updatedWebhook = {
			...validWebhookInit,
			id: webhookId,
			webhookUrl: 'https://different-url.com/webhook'
		};

		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/${webhookId}`, {
			method: 'PUT',
			headers: {
				Authorization: testUserJwt,
			},
			body: JSON.stringify(updatedWebhook),
		});
		expect(response.status).toBe(400);
	});

	it('successfully deletes a webhook', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/${webhookId}`, {
			method: 'DELETE',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(200);

		// Verify webhook was deleted by trying to list it
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}`, {
			method: 'GET',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(200);
		const webhooks = await response.json() as StripeIntegration[];
		expect(webhooks.some(webhook => webhook.id === webhookId)).toBe(false);
	});

	it('fails to delete webhook with invalid id', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/invalid_id`, {
			method: 'DELETE',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(400);
	});

	describe('Webhook Endpoint Tests', () => {
		const stripe = new Stripe(validWebhookInit.stripePrivateKey, {
			httpClient: Stripe.createFetchHttpClient()
		});
		// from stripe test dashboard
		const productId = 'prod_RaNeaDpniWdiK4';
		const priceId = 'price_1QhCsvIz61apsROqzT6eFZ2B';
		let subscriptionId: string;

		beforeAll(async () => {
			response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}`, {
				method: 'POST',
				headers: {
					Authorization: testUserJwt,
				},
				body: JSON.stringify(validWebhookInit),
			});
			const webhook = await response.json() as StripeIntegration;
			webhookId = webhook.id;
			webhookUrl = webhook.webhookUrl;
			await Firebase.Admin.setClaims(serviceAccount, testUserId, {});
		});

		it('fails webhook call without stripe signature', async () => {
			response = await SELF.fetch(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: '{}',
			});
			expect(response.status).toBe(400);
		});

		it('fails webhook call with invalid stripe signature', async () => {
			response = await SELF.fetch(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Stripe-Signature': 'invalid_signature',
				},
				body: '{}',
			});
			expect(response.status).toBe(401);
		});

		it('fails webhook call with invalid webhook ID', async () => {
			response = await SELF.fetch(`https://example.com/v1/stripe/${testUserId}/invalid_webhook_id`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Stripe-Signature': 'invalid_signature',
				},
				body: '{}',
			});
			expect(response.status).toBe(404);
		});

		it('successfully processes webhook with valid signature', async () => {
			// https://dashboard.stripe.com/test/customers/cus_RoNS7LKeXVWZCg
			const customer = await stripe.customers.retrieve('cus_RoNS7LKeXVWZCg');
			const session = await stripe.checkout.sessions.create({
				mode: 'subscription',
				success_url: 'https://example.com/success',
				// subscription_data: {
				// 	metadata: {
				// 		auth_user_id: testUserId
				// 	}
				// },
				line_items: [{
					price: priceId,
					// price_data: {
					// 	product: productId,
					// 	currency: 'usd',
					// 	unit_amount: 10,
					// },
					quantity: 1
				}],
			});
			session.subscription = await stripe.subscriptions.create({
				customer: customer.id,
				items: [{
					price: priceId,
				}],
				default_payment_method: 'pm_1QukhzIz61apsROqqUl2wxR1',
			});
			const payload = JSON.stringify({
				type: 'checkout.session.completed',
				data: {
					object: {
						client_reference_id: testUserId,
						subscription: session.subscription,
						customer: customer.id,
						},
					}
				},
			);
			subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
			const header = await stripe.webhooks.generateTestHeaderStringAsync({
				payload,
				secret: validWebhookInit.webhookSecret,
			});
			response = await SELF.fetch(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Stripe-Signature': header,
				},
				body: payload,
			});
			if (response.status !== 200) {
				const errorText = await response.text();
				console.error('Response status:', response.status);
				console.error('Response text:', errorText);
			}
			expect(response.status).toBe(200);
		});

		it('successfully finds subscription created', async () => {
			response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/${webhookId}/subscriptions`, {
				method: 'GET',
				headers: {
					Authorization: testUserJwt,
				},
			});
			expect(response.status).toBe(200);
			const subscriptions = await response.json() as CustomClaims[];
			const savedSub = subscriptions.find(sub => sub[subscriptionId])?.[subscriptionId];
			expect(savedSub).toBeDefined();
			expect(savedSub?.status).toBe('active');
			expect(savedSub?.prods.length).toBe(1);
			expect(savedSub?.prods[0]).toBe('1xprod_RaNeaDpniWdiK4');
		});

		// Clean up webhook after tests
		afterAll(async () => {
			await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/${webhookId}`, {
				method: 'DELETE',
				headers: {
					Authorization: testUserJwt,
				},
			});
		});
	});
});
