import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	ApiProxy,
	EndUserAnalytics,
} from '../../src/services/repos/models';
import {
  testUserId,
  testUserJwt,
  openAIProxyInit,
  testUser1stUserJwt,
  testUser2ndUserJwt,
  testUser1stUserId,
} from './config';

describe('Firebase + OpenAI API Proxy: user access control for files', () => {
	let fileId1stUser: string, fileId2ndUser: string;
  let response, proxyId, reqHeader: string;
	beforeAll(async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: openAIProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(openAIProxyInit)['apiReqHeader'];

		const body = (() => {
			const formData = new FormData();
    // Create proper JSONL content with training examples
			const jsonlContent = [
				JSON.stringify({"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "Hello"}, {"role": "assistant", "content": "Hi! How can I help you today?"}]}),
				JSON.stringify({"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "What's the weather?"}, {"role": "assistant", "content": "I don't have access to current weather information. You would need to check a weather service or app for that information."}]})
			].join('\n');
			formData.append(
				'file',
				new Blob([jsonlContent], { type: 'application/x-ndjson' }),
				'example.jsonl'
			);
			formData.append('purpose', 'fine-tune');
			return formData;
		})();

		// 1st user creates file
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
				body,
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
		fileId1stUser = ((await response.json()) as any).id;

		// 2nd user creates file
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
				body,
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
		fileId2ndUser = ((await response.json()) as any).id;
	});
	afterAll(async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId1stUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId2ndUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
	});

	it('forbids /batches which is not in whitelist', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/batches`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('1st user can get it directly', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId1stUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('1st user can get contents', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId1stUser}/content`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
	});

	it('1st user only list its files', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		expect(response.status).toBe(200);
		let res: any = await response.json();
		expect(res.data.length).toBe(1);
	});

	it('2nd user fails to get file', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId1stUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('2nd user fails to get contents', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId1stUser}/contents`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
			},
		);
		if (response.status !== 403)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(403);
	});

	it('2nd user fails to get it when listing files', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
			},
		);
		expect(response.status).toBe(200);
		let res: any = await response.json();
		expect(res.data.length).toBe(1);
	});

	it('2nd user cannot delete', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId1stUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
			},
		);
		if (response.status !== 403)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(403);
	});

	it('1st user fails to get it', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId2ndUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('1st user cannot delete', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId2ndUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		if (response.status !== 403)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(403);
	});

	it('2nd user can get it', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId2ndUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('2nd user can get contents', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId2ndUser}/content`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
	});

	it('1st user fails to get contents', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/files/${fileId2ndUser}/contents`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
				},
			},
		);
		if (response.status !== 403)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(403);
	});
});

describe('Firebase + OpenAI Proxy: completion + summary', async () => {
  let response, proxyId, reqHeader: string;
	beforeAll(async () => {
		// create proxy
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: openAIProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(openAIProxyInit)['apiReqHeader'];
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

	it('chat completion endpoint', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/chat/completions`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'gpt-4o-mini',
					messages: [
						{
							role: 'system',
							content: 'You are a helpful assistant.',
						},
						{
							role: 'user',
							content: 'Hello!',
						},
					],
				}),
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
});

describe('Firebase + OpenAI Proxy: user access control for threads', async () => {
	let threadId1stUser: string, threadId2ndUser: string;
  let response, proxyId, reqHeader: string;
	beforeAll(async () => {
		// create proxy
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: openAIProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl).toBe(`https://example.com/v1/proxy/${testUserId}/${data.id}`);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(openAIProxyInit)['apiReqHeader'];

		// 1st user creates thread
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(200);
		threadId1stUser = ((await response.json()) as any).id;

		// 2nd user creates thread
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(200);
		threadId2ndUser = ((await response.json()) as any).id;
	});

	afterAll(async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId1stUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId2ndUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
	});

	it('1st user can get it directly', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId1stUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('1st user can get messages', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId1stUser}/messages`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('2nd user fails to get it directly', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId1stUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('2nd user fails to get messages', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId1stUser}/messages`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(403);
	});
	it('2nd user cannot delete', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId1stUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('1st user fails to get it', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId2ndUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('1st user cannot delete', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId2ndUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: `Bearer ${testUser1stUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('2nd user can get it', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId2ndUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('2nd user can get messages', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1/threads/${threadId2ndUser}/messages`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: `Bearer ${testUser2ndUserJwt}`,
					'OpenAI-Beta': 'assistants=v2',
				},
			},
		);
		expect(response.status).toBe(200);
	});
	it('avoid key collision when listing proxies', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'GET',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(200);
	});
});