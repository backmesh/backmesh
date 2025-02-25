import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';

import KV from '../../src/services/repos/kv';
import { AuthProviderType, CustomClaims, SchemaVersion, StripeIntegration } from '../../src/services/repos/models';
import { getTokenFromFirebaseKey } from '../utils';
import Supabase from '../../src/services/gateways/supabase';

// backmesh firebase account
const testUserJwt = await getTokenFromFirebaseKey(
	env.BACKMESH_FIREBASE_KEY,
	env.FIREBASE_TEST_USER_EMAIL,
	env.TEST_USER_PASS,
);
const testUserId = env.FIREBASE_TEST_USER_ID;

// supabase user account
const projectUrl = env.SUPABASE_TEST_USER_URL;
const privateKey = env.SUPABASE_TEST_USER_SERVICE_ROLE;

// supabase test end user
const testEndUserId = env.SUPABASE_TEST_USER_USER_ID;

const stripeKey = env.TEST_STRIPE_KEY;
const stripeWebhookSecret = env.TEST_STRIPE_WEBHOOK_SECRET;

const baseUrl = 'https://example.com/v1';
const webhookId = KV.generateId();
const webhookUrl = `${baseUrl}/stripe/${testUserId}/${webhookId}`;
const validWebhookInit = {
	id: webhookId,
	webhookUrl,
	webhookSecret: stripeWebhookSecret,
	stripePrivateKey: stripeKey,
	authPrivateKey: privateKey,
	authType: AuthProviderType.SUPABASE,
	schemaVersion: SchemaVersion.V1,
	authAppId: projectUrl,
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
			client_reference_id: testEndUserId,
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

describe('Stripe Integration CRUD Operations with Supabase', () => {
	let response: Response;
	// Add beforeAll to ensure clean state
	beforeAll(async () => {
		response = await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}`, {
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
		expect(webhook.webhookUrl).toBe(`${baseUrl}/stripe/${testUserId}/${webhook.id}`);
		expect(webhook.webhookSecret).toBe('');
		expect(webhook.stripePrivateKey).toBe('');
		expect(webhook.authPrivateKey).toBe('');
	});

	it('successfully lists webhooks with webhookUrl', async () => {
		response = await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}`, {
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

		response = await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}/${webhookId}`, {
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

	it('successfully deletes a webhook', async () => {
		response = await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}/${webhookId}`, {
			method: 'DELETE',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(200);

		// Verify webhook was deleted by trying to list it
		response = await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}`, {
			method: 'GET',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(200);
		const webhooks = await response.json() as StripeIntegration[];
		expect(webhooks.some(webhook => webhook.id === webhookId)).toBe(false);
	});

	describe('Webhook Endpoint Tests', () => {

		beforeAll(async () => {
			await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testEndUserId, claims: {}});
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
			response = await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}/${webhookId}/subscriptions`, {
				method: 'GET',
				headers: {
					Authorization: testUserJwt,
				},
			});
			expect(response.status).toBe(200);
			const claims: CustomClaims[] = await response.json();
			const claim = claims
				.find((s: CustomClaims) => s.uid === testEndUserId)
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
							auth_user_id: testEndUserId
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
			response = await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}/${webhookId}/subscriptions`, {
				method: 'GET',
				headers: {
					Authorization: testUserJwt,
				},
			});
			expect(response.status).toBe(200);
			const claims: CustomClaims[] = await response.json();
			const claim = claims
				.find((s: CustomClaims) => s.uid === testEndUserId)
			const savedSub = claim?.stripe_subs?.[subscription.id];
			expect(savedSub).toBeDefined();
			expect(savedSub?.status).toBe('canceled');
			expect(savedSub?.prods.length).toBe(1);
			expect(savedSub?.prods[0]).toBe(`1x${productId}`);
		});

		// Clean up webhook after tests
		afterAll(async () => {
			await SELF.fetch(`${baseUrl}/crud/stripe/${testUserId}/${webhookId}`, {
				method: 'DELETE',
				headers: {
					Authorization: testUserJwt,
				},
			});
			await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testEndUserId, claims: {}});
		});
	});
});
