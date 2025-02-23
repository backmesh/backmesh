import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { AuthProviderType, SchemaVersion, StripeWebhook } from '../src/services/repos/models';
import { getTokenFromFirebaseKey } from './utils';


const backmeshFirebaseKey = env.BACKMESH_FIREBASE_KEY;
const testUserEmail = env.FIREBASE_TEST_USER_EMAIL;
const testUserId = env.FIREBASE_TEST_USER_ID;
const testUserJwt = await getTokenFromFirebaseKey(
	backmeshFirebaseKey,
	testUserEmail,
	env.TEST_USER_PASS,
);

describe('Stripe Webhook CRUD Operations', () => {
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
		const webhook = await response.json() as StripeWebhook;
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
		const webhook = await response.json() as StripeWebhook;
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
		const webhooks = await response.json() as StripeWebhook[];
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
		const webhook = await response.json() as StripeWebhook;
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
		const webhooks = await response.json() as StripeWebhook[];
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
});
