import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	ApiProxy,
	EndUserAnalytics,
} from '../../src/services/repos/models';
import {
  cloudflareAccountId,
  cloudflareProxyInit,
  testUserId,
  testUserJwt,
  testUser1stUserJwt,
  testUser1stUserId,
} from './config';

describe('Firebase + Cloudflare API Proxy Run model usage', () => {
  let response, proxyId, reqHeader: string;
	const messageBody = JSON.stringify({
		messages: [{ role: 'user', content: 'Hello, world' }],
	});
	const runEndpoint = `client/v4/accounts/${cloudflareAccountId}/ai/run/@cf/meta/llama-3.2-1b-instruct`
	const wrongEndpoint = `client/v4/accounts/${cloudflareAccountId}/ai/finetunes`
	beforeAll(async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: cloudflareProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(cloudflareProxyInit)['apiReqHeader'];
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

	it('run model endpoint', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/${runEndpoint}`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
				body: messageBody,
			},
		);
		if (response.status !== 200) console.error(await response.text());
		expect(response.status).toBe(200);

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
		expect(body[0].totalCost).toBeGreaterThan(0);
		expect(body[0].totalTiming).toBeGreaterThan(0);
		expect(body[0].errorCount).toBe(0);
		expect(body[0].reqCount).toBe(1);
		expect(body[0].firstTs).toBeGreaterThan(0);
		expect(body[0].lastTs).toBe(body[0].lastTs);
	});

	it('forbid any endpoint outside of whitelist', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/${wrongEndpoint}`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
				body: messageBody,
			},
		);
		if (response.status !== 403) console.error(await response.text());
		expect(response.status).toBe(403);
	});
});
