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

const validWebhookInit = {
	webhookSecret: stripeWebhookSecret,
	stripePrivateKey: stripeKey,
	authPrivateKey: serviceAccount,
	authType: AuthProviderType.FIREBASE,
	schemaVersion: SchemaVersion.V1,
};

const stripe = new Stripe(validWebhookInit.stripePrivateKey, {
	httpClient: Stripe.createFetchHttpClient()
});
// from stripe test dashboard
const productId = 'prod_RaNeaDpniWdiK4';
const priceId = 'price_1QhCsvIz61apsROqzT6eFZ2B';
// https://dashboard.stripe.com/test/customers/cus_RoNS7LKeXVWZCg
const customer = await stripe.customers.retrieve('cus_RoNS7LKeXVWZCg');
const session = await stripe.checkout.sessions.create({
	mode: 'subscription',
	success_url: 'https://example.com/success',
	line_items: [{
		price: priceId,
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
const subscription = session.subscription;
const header = await stripe.webhooks.generateTestHeaderStringAsync({
	payload,
	secret: validWebhookInit.webhookSecret,
});

describe('Stripe Integration CRUD Operations', () => {
	let response: Response;
	let webhookId: string;
	let webhookUrl: string;
	// Add beforeAll to ensure clean state
	beforeAll(async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: JSON.stringify(validWebhookInit),
		});
		if (response.status !== 200) {
			const errorText = await response.text();
			console.error('Response status:', response.status);
			console.error('Response text:', errorText);
		}
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

		it('successfully processes webhook with valid signature for checkout.session.completed', async () => {
			// https://dashboard.stripe.com/test/customers/cus_RoNS7LKeXVWZCg

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
			const claims: CustomClaims[] = await response.json();
			const claim = claims
				.find((s: CustomClaims) => s.uid === testUserId)
			const savedSub = claim?.stripe_subs?.[subscription.id];
			expect(savedSub).toBeDefined();
			expect(savedSub?.status).toBe('active');
			expect(savedSub?.prods.length).toBe(1);
			expect(savedSub?.prods[0]).toBe(`1x${productId}`);
		});

		it('successfully processes webhook with valid signature to cancel subscription', async () => {
			const payloadCancel = JSON.stringify({
				type: 'customer.subscription.updated',
				data: {
					object: {
						...subscription,
						status: 'canceled',
						metadata: {
							auth_user_id: testUserId
						}
					}
				}
			});
			const header = await stripe.webhooks.generateTestHeaderStringAsync({
				payload: payloadCancel,
				secret: validWebhookInit.webhookSecret,
			});
			response = await SELF.fetch(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Stripe-Signature': header,
				},
				body: payloadCancel,
			});
			if (response.status !== 200) {
				const errorText = await response.text();
				console.error('Response status:', response.status);
				console.error('Response text:', errorText);
			}
			expect(response.status).toBe(200);
		});

		it('successfully finds subscription canceled', async () => {
			response = await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/${webhookId}/subscriptions`, {
				method: 'GET',
				headers: {
					Authorization: testUserJwt,
				},
			});
			expect(response.status).toBe(200);
			const claims: CustomClaims[] = await response.json();
			const claim = claims
				.find((s: CustomClaims) => s.uid === testUserId)
			const savedSub = claim?.stripe_subs?.[subscription.id];
			expect(savedSub).toBeDefined();
			expect(savedSub?.status).toBe('canceled');
			expect(savedSub?.prods.length).toBe(1);
			expect(savedSub?.prods[0]).toBe(`1x${productId}`);
		});

		// Clean up webhook after tests
		afterAll(async () => {
			await SELF.fetch(`https://example.com/v1/crud/stripe/${testUserId}/${webhookId}`, {
				method: 'DELETE',
				headers: {
					Authorization: testUserJwt,
				},
			});
			await Firebase.Admin.setClaims(serviceAccount, testUserId, {});
		});
	});

	describe('Stripe Admin/Self Subscription Tests', () => {
		let response: Response;
		beforeAll(async () => {
			await Firebase.Admin.setClaims(serviceAccount, testUserId, {});
		});

		it('successfully create subscription in backmesh itself', async () => {

			response = await SELF.fetch('https://example.com/v1/stripe', {
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
			const claims = await Firebase.Admin.getClaims(serviceAccount, testUserId);
			expect(claims?.stripe_subs).toBeDefined();
			expect(claims?.stripe_subs?.[subscription.id]).toBeDefined();
			expect(claims?.stripe_subs?.[subscription.id].status).toBe('active');
			expect(claims?.stripe_subs?.[subscription.id].prods.length).toBe(1);
			expect(claims?.stripe_subs?.[subscription.id].prods[0]).toBe(`1x${productId}`);
		});

		// Clean up webhook after tests
		afterAll(async () => {
			await Firebase.Admin.setClaims(serviceAccount, testUserId, {});
		});
	});
});
