import { describe, it, expect } from 'vitest';
import { decrypt, encrypt } from '../src/services/crypto';

describe('crypto', () => {
	it('properly encrypts and decrypts', async () => {
		const secret = 'secret';
		const password = 'password';
		const encryptedData = await encrypt(secret, password);
		expect(await decrypt(encryptedData, password)).toMatch(secret);
	});
});
