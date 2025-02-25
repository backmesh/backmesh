import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	ApiProxy,
	EndUserAnalytics,
} from '../../src/services/repos/models';
import {
  testUserId,
  testUserJwt,
  anthropicProxyInit,
  testUser1stUserJwt,
  testUser1stUserId,
} from './config';

describe('Firebase + Anthropic API Proxy Completion usage', () => {
  let response, proxyId, reqHeader: string;
	const messageBody = JSON.stringify({
		model: 'claude-3-5-sonnet-20240620',
		max_tokens: 1024,
		messages: [{ role: 'user', content: 'Hello, world' }],
	});
	const completionBody = JSON.stringify({
		model: 'claude-2.1',
		max_tokens_to_sample: 1024,
		prompt: '\n\nHuman: Hello, Claude\n\nAssistant:',
	});
	beforeAll(async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: anthropicProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(anthropicProxyInit)['apiReqHeader'];
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

	it('message endpoint', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/messages`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: testUser1stUserJwt,
					'anthropic-version': '2023-06-01',
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
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/completions`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: testUser1stUserJwt,
					'anthropic-version': '2023-06-01',
				},
				body: completionBody,
			},
		);
		if (response.status !== 403) console.error(await response.text());
		expect(response.status).toBe(403);
	});
});