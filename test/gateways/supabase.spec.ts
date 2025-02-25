import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Supabase from '../../src/services/gateways/supabase';
import { getTokenFromSupabase } from '../utils';

// account
const projectUrl = env.SUPABASE_TEST_USER_URL;
const supabaseKey = env.SUPABASE_TEST_USER_KEY;
const privateKey = env.SUPABASE_TEST_USER_SERVICE_ROLE;

// test end user
const testUserEmail = env.SUPABASE_TEST_USER_USER_EMAIL;
const testUserId = env.SUPABASE_TEST_USER_USER_ID;
const testUserPass = env.TEST_USER_PASS;

describe('supabase', () => {
	it('properly auth user to get jwt and then use that jwt to get uid', async () => {
		const testUserJwt = await getTokenFromSupabase({
			supabaseKey,
			projectUrl,
			email: testUserEmail,
			password: testUserPass,
		});

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
		},
		email_verified: true,
	};
	const emptyClaims = {'stripe_subs': {}};

	beforeAll(async () => {
		// Clear any existing claims before tests
		await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testUserId, claims: emptyClaims});
	});

	it('should set and get a claim for a user', async () => {
		// Set claims
		await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testUserId, claims: testClaims});

		// Get claims and verify
		const claims = await Supabase.Admin.getClaims({privateKey, projectUrl, uid: testUserId});
		expect(claims['stripe_subs']).toEqual(testClaims['stripe_subs']);
		expect(claims['email_verified']).toEqual(testClaims['email_verified']);
	});


	it('should update a claim for a user', async () => {
		await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testUserId, claims: testClaims});

		// Update claims
		const updatedClaims = {
			stripe_subs: {
				'sub_1QhCsvIz61apsROqzT6eFZ2B': {
					status: 'inactive',
					prods: ['1xprod_RaNeaDpniWdiK4'],
				},
				'sub_1QhCsvIz61apsROqzT6489348f': {
					status: 'trialing',
					prods: ['1xprod_RaNeaDpniWdiK4'],
				}
			},
		};
		await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testUserId, claims: updatedClaims});

		// Get claims and verify they're empty
		const claims = await Supabase.Admin.getClaims({privateKey, projectUrl, uid: testUserId});
		expect(claims['stripe_subs']).toEqual(updatedClaims['stripe_subs']);
		expect(claims['email_verified']).toEqual(testClaims['email_verified']);
	});

	it('should get all users claims', async () => {
		// First set some test claims
		await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testUserId, claims: testClaims});

		// Get all users claims
		const allClaims = await Supabase.Admin.getAllUsersClaims({privateKey, projectUrl});
		
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
			Supabase.Admin.getClaims({privateKey, projectUrl, uid: invalidUserId})
		).rejects.toThrow();

		// Attempt to set claims for invalid user
		await expect(
			Supabase.Admin.setClaims({privateKey, projectUrl, uid: invalidUserId, claims: testClaims})
		).rejects.toThrow();
	});

	it('should handle errors for invalid API key', async () => {
		const invalidKey = 'invalid-key';
		
		// Attempt to get claims with invalid key
		await expect(
			Supabase.Admin.getClaims({privateKey: invalidKey, projectUrl, uid: testUserId})
		).rejects.toThrow();

		// Attempt to set claims with invalid key
		await expect(
			Supabase.Admin.setClaims({privateKey: invalidKey, projectUrl, uid: testUserId, claims: testClaims})
		).rejects.toThrow();

		// Attempt to get all users claims with invalid key
		await expect(
			Supabase.Admin.getAllUsersClaims({privateKey: invalidKey, projectUrl})
		).rejects.toThrow();
	});

	// Clean up after all tests
	afterAll(async () => {
		await Supabase.Admin.setClaims({privateKey, projectUrl, uid: testUserId, claims: emptyClaims});
	});
});