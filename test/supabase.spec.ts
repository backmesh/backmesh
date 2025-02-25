import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Supabase from '../src/services/gateways/supabase';

const projectUrl = env.SUPABASE_TEST_USER_URL;
const supabaseKey = env.SUPABASE_TEST_USER_KEY;
const testUserEmail = env.SUPABASE_TEST_USER_USER_EMAIL;
const testUserId = env.SUPABASE_TEST_USER_USER_ID;
const testUserPass = env.TEST_USER_PASS;
const serviceRoleKey = env.SUPABASE_TEST_USER_SERVICE_ROLE;

// TODO refactor /proxy and /stripe tests to also use supabase in main paths
async function getTokenFromSupabase(
	email: string,
	password: string,
): Promise<string> {
	const response = await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: supabaseKey,
		},
		body: JSON.stringify({
			email: email,
			password: password,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error('Error response text:', errorText);
		throw new Error('Error verifying password: ' + response.statusText);
	}

	const data: any = await response.json();
	return data.access_token;
}

describe('supabase', () => {
	it('properly auth user to get jwt and then use that jwt to get uid', async () => {
		const testUserJwt = await getTokenFromSupabase(
			testUserEmail,
			testUserPass,
		);

		const uid = await Supabase.getUid(testUserJwt, supabaseKey, projectUrl);
		expect(uid).toMatch(testUserId);
	});
});

describe('supabase admin', () => {
	const testClaims = {
		stripe_subs: {
			'sub_1QhCsvIz61apsROqzT6eFZ2B': {
				status: 'active',
				prods: ['1xprod_RaNeaDpniWdiK4'],
			}
		}
	};

	beforeAll(async () => {
		// Clear any existing claims before tests
		await Supabase.Admin.setClaims({serviceRoleKey, projectUrl, uid: testUserId, claims: {}});
	});

	it('should set and get claims for a user', async () => {
		// Set claims
		await Supabase.Admin.setClaims({serviceRoleKey, projectUrl, uid: testUserId, claims: testClaims});

		// Get claims and verify
		const claims = await Supabase.Admin.getClaims({serviceRoleKey, projectUrl, uid: testUserId});
		expect(claims).toContain({
			...testClaims,
		});
	});


	it('should handle empty claims', async () => {
		// Set empty claims
		await Supabase.Admin.setClaims({serviceRoleKey, projectUrl, uid: testUserId, claims: {}});

		// Get claims and verify they're empty
		const claims = await Supabase.Admin.getClaims({serviceRoleKey, projectUrl, uid: testUserId});
		expect(claims).toEqual({});
	});

	it('should get all users claims', async () => {
		// First set some test claims
		await Supabase.Admin.setClaims({serviceRoleKey, projectUrl, uid: testUserId, claims: testClaims});

		// Get all users claims
		const allClaims = await Supabase.Admin.getAllUsersClaims({serviceRoleKey, projectUrl});
		
		// Verify the test user's claims are in the results
		const userClaims = allClaims.find(claim => claim.uid === testUserId);
		expect(userClaims).toBeDefined();
		expect(userClaims).toMatchObject({
			uid: testUserId,
			...testClaims
		});
	});

	it('should handle errors for invalid user ID', async () => {
		const invalidUserId = 'non-existent-user';
		
		// Attempt to get claims for invalid user
		await expect(
			Supabase.Admin.getClaims({serviceRoleKey, projectUrl, uid: invalidUserId})
		).rejects.toThrow();

		// Attempt to set claims for invalid user
		await expect(
			Supabase.Admin.setClaims({serviceRoleKey, projectUrl, uid: invalidUserId, claims: testClaims})
		).rejects.toThrow();
	});

	it('should handle errors for invalid API key', async () => {
		const invalidKey = 'invalid-key';
		
		// Attempt to get claims with invalid key
		await expect(
			Supabase.Admin.getClaims({serviceRoleKey: invalidKey, projectUrl, uid: testUserId})
		).rejects.toThrow();

		// Attempt to set claims with invalid key
		await expect(
			Supabase.Admin.setClaims({serviceRoleKey: invalidKey, projectUrl, uid: testUserId, claims: testClaims})
		).rejects.toThrow();

		// Attempt to get all users claims with invalid key
		await expect(
			Supabase.Admin.getAllUsersClaims({serviceRoleKey: invalidKey, projectUrl})
		).rejects.toThrow();
	});

	// Clean up after all tests
	afterAll(async () => {
		await Supabase.Admin.setClaims({serviceRoleKey, projectUrl, uid: testUserId, claims: {}});
	});
});