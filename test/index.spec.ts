import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import Firebase from '../src/services/gateways/firebase';
import {
	ApiProxy,
	AuthProviderType,
	EndUserAnalyticsSummary,
	RateLimitUnit,
} from '../src/services/kv';

async function getTokenFromFirebaseKey(
	publicFirebaseKey: string,
	email: string,
	password: string,
): Promise<string> {
	const response = await fetch(
		`https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${publicFirebaseKey}`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				email: email,
				password: password,
				returnSecureToken: true,
			}),
		},
	);

	if (!response.ok) {
		const errorText = await response.text();
		console.error('Error response text:', errorText);
		throw new Error('Error verifying password: ' + response.statusText);
	}

	const data: any = await response.json();
	return data.idToken;
}

const backmeshFirebaseKey = env.BACKMESH_FIREBASE_KEY;
// backmesh test user
const testUserAppId = env.FIREBASE_TEST_USER_APP_ID;
const testUserId = env.FIREBASE_TEST_USER_ID;
const testUserEmail = env.FIREBASE_TEST_USER_EMAIL;
const testUserFirebaseKey = env.FIREBASE_TEST_USER_KEY;
const testUserJwt = await getTokenFromFirebaseKey(
	backmeshFirebaseKey,
	testUserEmail,
	env.TEST_USER_PASS,
);

describe('Firebase Authentication UID <=> JWT Mapper', () => {
	it('properly auth user to get jwt and the use that jwt to get uid', async () => {
		const uid = await Firebase.getUid(testUserJwt, backmeshFirebaseKey);
		expect(uid).toMatch(testUserId);
	});
});

// backmesh user has 2 users calling the proxy
const testUser1stUserEmail = env.FIREBASE_TEST_USER_USER_1_EMAIL;
const testUser1stUserId =  env.FIREBASE_TEST_USER_USER_1_ID;
const testUser1stUserJwt = await getTokenFromFirebaseKey(
	testUserFirebaseKey,
	testUser1stUserEmail,
	env.TEST_USER_PASS,
);
console.log(testUser1stUserJwt);

const testUser2ndUserEmail = env.FIREBASE_TEST_USER_USER_2_EMAIL;
const testUser2ndUserId = env.FIREBASE_TEST_USER_USER_2_ID;
const testUser2ndUserJwt = await getTokenFromFirebaseKey(
	testUserFirebaseKey,
	testUser2ndUserEmail,
	env.TEST_USER_PASS,
);

const invalidProxyInit = JSON.stringify({
	apiUrl: 'https://generativelanguage.googleapis.com',
	apiReqHeader: 'x-goog-api-key',
	authPublicKey: testUserFirebaseKey,
	authAppId: testUserAppId,
	rateLimit: 2,
	rateLimitUnit: RateLimitUnit.MINUTE,
	authType: AuthProviderType.FIREBASE,
});
const rateLimitProxyInit = JSON.stringify({
	...JSON.parse(invalidProxyInit),
	apiPrivateKey: env.TEST_USER_GEMINI_API_KEY,
});
const geminiProxyInit = JSON.stringify({
	...JSON.parse(invalidProxyInit),
	apiPrivateKey: env.TEST_USER_GEMINI_API_KEY,
	rateLimit: 20,
});
// TODO use supabase to test both
const openAIProxyInit = JSON.stringify({
	apiUrl: 'https://api.openai.com',
	apiReqHeader: 'Authorization',
	authPublicKey: testUserFirebaseKey,
	apiPrivateKey: env.TEST_USER_OPENAI_API_KEY,
	authAppId: testUserAppId,
	rateLimit: 20,
	rateLimitUnit: RateLimitUnit.MINUTE,
	authType: AuthProviderType.FIREBASE,
});
const anthropicProxyInit = JSON.stringify({
	apiUrl: 'https://api.anthropic.com',
	apiReqHeader: 'x-api-key',
	authPublicKey: testUserFirebaseKey,
	apiPrivateKey: env.TEST_USER_ANTHROPIC_API_KEY,
	authAppId: testUserAppId,
	rateLimit: 20,
	rateLimitUnit: RateLimitUnit.MINUTE,
	authType: AuthProviderType.FIREBASE,
});

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

let response, proxyId, reqHeader: string;
describe('Firebase + Gemini API Proxy Failed Creations', () => {
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

describe('Firebase + OpenAI API Proxy: user access control for files', () => {
	let fileId1stUser: string, fileId2ndUser: string;
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

describe('Firebase + Gemini API Proxy user access control for files', () => {
	let fileId1stUser: string, fileId2ndUser: string;
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
		const body: EndUserAnalyticsSummary[] = await response.json();
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
		const body: EndUserAnalyticsSummary[] = await response.json();
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

describe('Firebase + OpenAI Proxy: completion + summary', async () => {
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
		const body: EndUserAnalyticsSummary[] = await response.json();
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
		const body: EndUserAnalyticsSummary[] = await response.json();
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

describe('Firebase + Gemini API Proxy Rate Limit', () => {
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

describe('Firebase + Anthropic API Proxy Completion usage', () => {
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
		const body: EndUserAnalyticsSummary[] = await response.json();
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
		const body: EndUserAnalyticsSummary[] = await response.json();
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
