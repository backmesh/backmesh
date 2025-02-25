import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import {
  testUserId,
  testUserJwt,
  geminiProxyInit,
  invalidProxyInit,
} from './config';

describe('Bad proxy requests', () => {
	it('invalid proxy path', async () => {
		let response = await SELF.fetch('https://example.com/v1/proxy/', {
			method: 'POST',
			body: '{}',
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Invalid pathname');
	});
	it('not found headers', async () => {
		let response = await SELF.fetch(
			'https://example.com/v1/proxy/asdfasdf/asdfsadf',
			{
				method: 'POST',
				body: '{}',
			},
		);
		expect(response.status).toBe(404);
	});
});

describe('Firebase + Gemini API Proxy Failed Creations', () => {
  let response;
	it('fails to create proxy with no token', async () => {
		response = await SELF.fetch('https://example.com/v1/crud/proxy/backmeshUid', {
			method: 'POST',
			headers: {
				Authorization: 'asdfsdf',
			},
			body: geminiProxyInit,
		});
		expect(response.status).toBe(401);
	});
	it('fails to create proxy with invalid token', async () => {
		response = await SELF.fetch('https://example.com/v1/crud/proxy/backmeshUid', {
			method: 'POST',
			headers: {
				Authorization: 'asdfsdf',
			},
			body: geminiProxyInit,
		});
		expect(response.status).toBe(401);
	});
	it('fails to create proxy with invalid header field', async () => {
		response = await SELF.fetch('https://example.com/v1/crud/proxy/', {
			method: 'POST',
			headers: {
				Authorizationnnnnn: testUserJwt,
			},
			body: geminiProxyInit,
		});
		expect(response.status).toBe(401);
	});
	it('fails to create proxy with invalid path', async () => {
		response = await SELF.fetch('https://example.com/v1/crud/proxy/', {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: geminiProxyInit,
		});
		expect(response.status).toBe(401);
	});
	it('fails to create proxy with invalid uid', async () => {
		response = await SELF.fetch('https://example.com/v1/crud/proxy/backmeshUid', {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: geminiProxyInit,
		});
		expect(response.status).toBe(401);
	});
	it('fails to create a proxy without private key', async () => {
		response = await SELF.fetch(`https://example.com/v1/crud/proxy/${testUserId}`, {
			method: 'POST',
			headers: {
				Authorization: testUserJwt,
			},
			body: invalidProxyInit,
		});
		expect(response.status).toBe(400);
	});
});
