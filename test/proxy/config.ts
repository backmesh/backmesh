import { env } from "cloudflare:test";
import { AuthProviderType } from "../../src/services/repos/models";

import { RateLimitUnit } from "../../src/services/repos/models";
import { getTokenFromFirebaseKey } from "../utils";


export const backmeshFirebaseKey = env.BACKMESH_FIREBASE_KEY;
// backmesh test user
export const testUserAppId = env.FIREBASE_TEST_USER_APP_ID;
export const testUserId = env.FIREBASE_TEST_USER_ID;
export const testUserEmail = env.FIREBASE_TEST_USER_EMAIL;
export const testUserFirebaseKey = env.FIREBASE_TEST_USER_KEY;
export const testUserJwt = await getTokenFromFirebaseKey(
	backmeshFirebaseKey,
	testUserEmail,
	env.TEST_USER_PASS,
);

// backmesh user has 2 users calling the proxy
export const testUser1stUserEmail = env.FIREBASE_TEST_USER_USER_1_EMAIL;
export const testUser1stUserId =  env.FIREBASE_TEST_USER_USER_1_ID;
export const testUser1stUserJwt = await getTokenFromFirebaseKey(
	testUserFirebaseKey,
	testUser1stUserEmail,
	env.TEST_USER_PASS,
);
// console.log(testUser1stUserJwt);

export const testUser2ndUserEmail = env.FIREBASE_TEST_USER_USER_2_EMAIL;
export const testUser2ndUserId = env.FIREBASE_TEST_USER_USER_2_ID;
export const testUser2ndUserJwt = await getTokenFromFirebaseKey(
	testUserFirebaseKey,
	testUser2ndUserEmail,
	env.TEST_USER_PASS,
);

export const geminiModel = 'gemini-1.5-flash';

export const invalidProxyInit = JSON.stringify({
	apiUrl: 'https://generativelanguage.googleapis.com',
	apiReqHeader: 'x-goog-api-key',
	authPublicKey: testUserFirebaseKey,
	authAppId: testUserAppId,
	rateLimit: 2,
	rateLimitUnit: RateLimitUnit.MINUTE,
	authType: AuthProviderType.FIREBASE,
});
export const rateLimitProxyInit = JSON.stringify({
	...JSON.parse(invalidProxyInit),
	apiPrivateKey: env.TEST_USER_GEMINI_API_KEY,
});
export const geminiProxyInit = JSON.stringify({
	...JSON.parse(invalidProxyInit),
	apiPrivateKey: env.TEST_USER_GEMINI_API_KEY,
	rateLimit: 20,
});
export const openAIProxyInit = JSON.stringify({
	apiUrl: 'https://api.openai.com',
	apiReqHeader: 'Authorization',
	authPublicKey: testUserFirebaseKey,
	apiPrivateKey: env.TEST_USER_OPENAI_API_KEY,
	authAppId: testUserAppId,
	rateLimit: 20,
	rateLimitUnit: RateLimitUnit.MINUTE,
	authType: AuthProviderType.FIREBASE,
});

export const cloudflareProxyInit = JSON.stringify({
	apiUrl: 'https://api.cloudflare.com',
	apiReqHeader: 'Authorization',
	authPublicKey: testUserFirebaseKey,
	apiPrivateKey: env.TEST_USER_CLOUDFLARE_API_KEY,
	authAppId: testUserAppId,
	rateLimit: 20,
	rateLimitUnit: RateLimitUnit.MINUTE,
	authType: AuthProviderType.FIREBASE,
});
export const cloudflareAccountId = env.TEST_USER_CLOUDFLARE_ACCOUNT_ID;

export const anthropicProxyInit = JSON.stringify({
	apiUrl: 'https://api.anthropic.com',
	apiReqHeader: 'x-api-key',
	authPublicKey: testUserFirebaseKey,
	apiPrivateKey: env.TEST_USER_ANTHROPIC_API_KEY,
	authAppId: testUserAppId,
	rateLimit: 20,
	rateLimitUnit: RateLimitUnit.MINUTE,
	authType: AuthProviderType.FIREBASE,
});