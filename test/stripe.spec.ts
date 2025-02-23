import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';

import { AuthProviderType, SchemaVersion, StripeIntegration } from '../src/services/repos/models';
import { getTokenFromFirebaseKey } from './utils';


const backmeshFirebaseKey = env.BACKMESH_FIREBASE_KEY;
const testUserEmail = env.FIREBASE_TEST_USER_EMAIL;
const testUserId = env.FIREBASE_TEST_USER_ID;
const testUserJwt = await getTokenFromFirebaseKey(
	backmeshFirebaseKey,
	testUserEmail,
	env.TEST_USER_PASS,
);

describe('Stripe Integration CRUD Operations', () => {
	let response: Response;
	let webhookId: string;
	let webhookUrl: string;

	const validWebhookInit = {
		webhookSecret: 'whsec_test_secret',
		stripePrivateKey: 'sk_test_key',
		authPrivateKey: JSON.stringify({
			type: 'service_account',
			project_id: 'test-project',
			private_key: 'test-private-key',
			client_email: 'test@test.com'
		}),
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
		const payload = JSON.stringify({
			type: 'customer.subscription.created',
			data: {
				object: {
					customer: 'cus_test123',
					status: 'active'
				}
			}
		});
		const stripe = new Stripe(validWebhookInit.stripePrivateKey, {
			httpClient: Stripe.createFetchHttpClient()
		});

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
		});

		it('fails webhook call without stripe signature', async () => {
			response = await SELF.fetch(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: payload,
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
				body: payload,
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
				body: payload,
			});
			expect(response.status).toBe(404);
		});

		it('successfully processes webhook with valid signature', async () => {
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
