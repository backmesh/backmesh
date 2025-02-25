import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import Firebase from '../../src/services/gateways/firebase';

import { getTokenFromFirebaseKey } from '../utils';

const backmeshFirebaseKey = env.BACKMESH_FIREBASE_KEY;
const testUserId = env.FIREBASE_TEST_USER_ID;
const testUserEmail = env.FIREBASE_TEST_USER_EMAIL;
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
