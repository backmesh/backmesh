import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	ApiProxy,
	EndUserAnalytics,
} from '../../src/services/repos/models';
import {
  testUserId,
  testUserJwt,
  geminiProxyInit,
  testUser1stUserJwt,
  testUser2ndUserJwt,
  testUser1stUserId,
  rateLimitProxyInit,
} from './config';


describe('Firebase + Gemini API Proxy user access control for files', () => {
	let fileId1stUser: string, fileId2ndUser: string;
  let response, proxyId, reqHeader: string;
	beforeAll(async () => {
		// create proxy
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: geminiProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(geminiProxyInit)['apiReqHeader'];

		// Create a fake text Blob
		const fakeBlob = new Blob(['fake text content'], { type: 'text/plain' });

		// 1st user creates file
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/upload/v1beta/files`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: testUser1stUserJwt,
					'X-Goog-Upload-Protocol': 'resumable',
					'X-Goog-Upload-Command': 'start',
					'X-Goog-Upload-Header-Content-Length': fakeBlob.size.toString(),
					'X-Goog-Upload-Header-Content-Type': 'text/plain',
					'Content-Type': 'application/json',
				},
			},
		);
		expect(response.status).toBe(200);

		let uploadUrl = response.headers.get('x-goog-upload-url')!;
		expect(uploadUrl).toBeTruthy();
		uploadUrl = uploadUrl.replace(
			'https://generativelanguage.googleapis.com/',
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/`,
		);

		// Upload the actual bytes using Blob
		response = await SELF.fetch(uploadUrl, {
			method: 'POST',
			headers: {
				[reqHeader]: testUser1stUserJwt,
				'Content-Length': fakeBlob.size.toString(),
				'X-Goog-Upload-Offset': '0',
				'X-Goog-Upload-Command': 'upload, finalize',
			},
			body: fakeBlob,
		});
		if (!response.ok) {
			console.error('Failed to proxy request:', await response.text());
		}
		expect(response.ok).toBe(true);

		let fileInfo: any = await response.json();
		let fileUri = fileInfo.file.uri;
		expect(fileUri).toBeTruthy();
		// files/lw388m83m4w8
		fileId1stUser = fileInfo.file.name;

		// 2nd user creates file
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/upload/v1beta/files`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: testUser2ndUserJwt,
					'X-Goog-Upload-Protocol': 'resumable',
					'X-Goog-Upload-Command': 'start',
					'X-Goog-Upload-Header-Content-Length': fakeBlob.size.toString(),
					'X-Goog-Upload-Header-Content-Type': 'TEXT',
					'Content-Type': 'application/json',
				},
			},
		);
		expect(response.status).toBe(200);

		uploadUrl = response.headers.get('x-goog-upload-url')!;
		expect(uploadUrl).toBeTruthy();
		uploadUrl = uploadUrl.replace(
			'https://generativelanguage.googleapis.com/',
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/`,
		);

		// Upload the actual bytes using Blob
		response = await SELF.fetch(uploadUrl, {
			method: 'POST',
			headers: {
				[reqHeader]: testUser2ndUserJwt,
				'Content-Length': fakeBlob.size.toString(),
				'X-Goog-Upload-Offset': '0',
				'X-Goog-Upload-Command': 'upload, finalize',
			},
			body: fakeBlob,
		});
		expect(response.ok).toBe(true);

		fileInfo = await response.json();
		fileUri = fileInfo.file.uri;
		expect(fileUri).toBeTruthy();
		// files/lw388m83m4w8
		fileId2ndUser = fileInfo.file.name;
	});
	afterAll(async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId1stUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId2ndUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: testUser2ndUserJwt,
				},
			},
		);
		if (response.status !== 200)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(200);
	});

	it('forbids /corpora which is not in whitelist', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/corpora`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('forbids /media which is not in whitelist', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/media`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('1st user can get it directly', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId1stUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('1st user only list its files', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/files`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);
		let res: any = await response.json();
		expect(res.files.length).toBe(1);
	});

	it('2nd user only lists its files', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId1stUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser2ndUserJwt,
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('2nd user fails to get it when listing files', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/files`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser2ndUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);
		let res: any = await response.json();
		expect(res.files.length).toBe(1);
	});

	it('2nd user cannot delete', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId1stUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: testUser2ndUserJwt,
				},
			},
		);
		if (response.status !== 403)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(403);
	});

	it('1st user fails to get it', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId2ndUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(403);
	});

	it('1st user cannot delete', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId2ndUser}`,
			{
				method: 'DELETE',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		if (response.status !== 403)
			console.error('Response body:', await response.text());
		expect(response.status).toBe(403);
	});

	it('2nd user can get it', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/${fileId2ndUser}`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser2ndUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);
	});
});

describe('Firebase + Gemini Proxy: completion + summary', async () => {
  let response, proxyId, reqHeader: string;
	beforeAll(async () => {
		// create proxy
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: geminiProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(geminiProxyInit)['apiReqHeader'];
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
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/models/gemini-1.5-flash:generateContent`,
			{
				method: 'POST',
				headers: {
					[reqHeader]: testUser1stUserJwt,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					contents: [
						{
							role: 'user',
							parts: [
								{
									text: 'I have two dogs in my house. How many paws are in my house?',
								},
							],
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

describe('Firebase + Gemini API Proxy Rate Limit', () => {
  let response, proxyId, reqHeader: string;
	beforeAll(async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: rateLimitProxyInit,
		});
		expect(response.status).toBe(200);
		let data = (await response.json()) as ApiProxy;
		expect(data.id.length).toBeGreaterThan(0);
		expect(data.proxyUrl.length).toBeGreaterThan(0);
		expect(data.apiPrivateKey === '').toBe(true);
		proxyId = data.id;
		reqHeader = JSON.parse(geminiProxyInit)['apiReqHeader'];
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

	it('bad path', async () => {
		response = await SELF.fetch(`https://example.com/v1/proxy/${testUserId}`, {
			method: 'GET',
			headers: {
				[reqHeader]: testUser1stUserJwt,
			},
		});
		expect(response.status).toBe(400);
	});

	it('bad token', async () => {
		response = await SELF.fetch(`https://example.com/v1/proxy/${testUserId}`, {
			method: 'GET',
			headers: {
				[reqHeader]: testUserJwt,
			},
		});
		expect(response.status).toBe(400);
	});

	it('not using proxy header', async () => {
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}`,
			{
				method: 'GET',
				headers: {
					InvalidHeader: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(401);
	});

	it('rate limits correctly', async () => {
		// not a valid path in proxy
		// but counts towards rate limit as 1st request for 1st user
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(403);

		// 2nd request for 1st user to proxy
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/models/gemini-pro`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);

		// 3rd request for 1st user should rate limit
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/models/gemini-pro`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(429);

		// but 1st request for 2nd user should go through
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/models/gemini-pro`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser2ndUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);

		// Wait for 60 seconds before making the next request for the 1st user
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		await wait(60000);

		// now the next request for 1st user should not rate limit
		response = await SELF.fetch(
			`https://example.com/v1/proxy/${testUserId}/${proxyId!}/v1beta/models/gemini-pro`,
			{
				method: 'GET',
				headers: {
					[reqHeader]: testUser1stUserJwt,
				},
			},
		);
		expect(response.status).toBe(200);
	});

	it('delete without proxy id fails', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'DELETE',
			headers: {
				Authorization: testUserJwt,
			},
		});
		expect(response.status).toBe(400);
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
