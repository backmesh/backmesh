import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import Supabase from '../src/services/gateways/supabase';

const supabaseUrl = env.SUPABASE_TEST_USER_URL;
const supabaseKey = env.SUPABASE_TEST_USER_KEY;
const testUserEmail = env.SUPABASE_TEST_USER_USER_EMAIL;
const testUserId = env.SUPABASE_TEST_USER_USER_ID;

async function getTokenFromSupabase(
	email: string,
	password: string,
): Promise<string> {
	const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
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
	it('properly auth user to get jwt and the use that jwt to get uid', async () => {
		const testUserJwt = await getTokenFromSupabase(
			testUserEmail,
			env.TEST_USER_PASS,
		);

		const uid = await Supabase.getUid(testUserJwt, supabaseKey, supabaseUrl);
		expect(uid).toMatch(testUserId);
	});
});
