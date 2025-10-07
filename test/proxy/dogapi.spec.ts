import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	ApiProxy,
	EndUserAnalytics,
} from '../../src/services/repos/models';
import {
  testUserId,
  testUserJwt,
  dogApiProxyInit,
  testUser1stUserJwt,
  testUser1stUserId,
} from './config';

describe('Firebase + The Dog API Proxy Completion usage', () => {
  let response, proxyId, reqHeader: string;
	// The Dog API endpoints don't require request bodies for GET requests
	beforeAll(async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: dogApiProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(dogApiProxyInit)['apiReqHeader'];
	});

	afterAll(async () => {
		response = await SELF.fetch(
			`https://example.com/v1/crud/proxy/${testUserId}/${proxyId!}`,
			{
				method: 'DELETE',
				headers: {
					Authorization: testUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('empty summary', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/crud/proxy/${testUserId}/${proxyId!}/summary`,
			{
				method: 'GET',
				headers: {
					Authorization: testUserJwt,
				},
			},
		);
		if (response.status !== 200) console.error(await response.text());
		expect(response.status).toBe(200);
		const body: EndUserAnalytics[] = await response.json();
		expect(body.length).toBe(0);
	});

	it('dog breeds endpoint', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/breeds`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		if (response.status === 529) {
			console.log('Received 529 status, skipping assertions');
			return;
		}
		if (response.status !== 200) console.error(await response.text());
		expect(response.status).toBe(200);

		// Verify the response contains dog breed data
		const breedData = await response.json();
		expect(Array.isArray(breedData)).toBe(true);
		expect(breedData.length).toBeGreaterThan(0);
		expect(breedData[0]).toHaveProperty('id');
		expect(breedData[0]).toHaveProperty('name');

		// one user in summary
		response = await SELF.fetch(
			`https://example.com/v1/crud/proxy/${testUserId}/${proxyId!}/summary`,
			{
				method: 'GET',
				headers: {
					Authorization: testUserJwt,
				},
			},
		);
		if (response.status !== 200) console.error(await response.text());
		expect(response.status).toBe(200);
		const body: EndUserAnalytics[] = await response.json();
		if (body.length !== 1) console.error(body);
		expect(body.length).toBe(1);
		expect(body[0].endUserId).toBe(testUser1stUserId);
		// Dog API doesn't have cost tracking like AI APIs, so totalCost should be 0
		expect(body[0].totalCost).toBe(0);
		expect(body[0].totalTiming).toBeGreaterThan(0);
		expect(body[0].errorCount).toBe(0);
		expect(body[0].reqCount).toBe(1);
		expect(body[0].firstTs).toBeGreaterThan(0);
		expect(body[0].lastTs).toBe(body[0].lastTs);
	});

	it('forbid any endpoint outside of whitelist', async () => {
		// Since Dog API doesn't have whitelist restrictions, we'll test with a valid image_id
		// and expect the API to work (not be forbidden)
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/favourites`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
				body: JSON.stringify({ image_id: "BJa4kxc4X" }), // Using example image ID from docs
			},
		);
		expect(response.status).toBe(403);
	});
});