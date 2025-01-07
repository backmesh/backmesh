// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
// https://github.com/bradyjoslin/encrypt-workers-kv/blob/master/src/index.ts
// https://github.com/bradyjoslin/webcrypto-example/blob/master/script.js
// https://www.youtube.com/watch?v=lbt2_M1hZeg

// used only for new encryptions since we save the number of iterations in the encrypted data
// https://community.cloudflare.com/t/long-running-webcrypto-api/90953/26?page=2
// might make sense to offload this to CF Workers Platform as the tradeoff
// between security and performance seems unavoidable in the free tier
// https://developers.cloudflare.com/api/operations/namespace-worker-put-script-secrets
// or a hacky server / GH action that invokes the wrangler CLI and passes data via stdin/out
const ITERATIONS = 100000;

const enc = new TextEncoder();
const dec = new TextDecoder();

// could be replaced by https://kian.org.uk/cryptokey-bindings-in-cloudflare-workers-importkey-at-publish-time/
// but this is a minority of the wall and cpu time
const getPasswordKey = (password: string): PromiseLike<CryptoKey> =>
	crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
		'deriveKey',
	]);

const deriveKey = (
	passwordKey: CryptoKey,
	salt: Uint8Array,
	keyUsage: CryptoKey['usages'],
): PromiseLike<CryptoKey> =>
	crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: salt,
			iterations: ITERATIONS,
			hash: 'SHA-256',
		},
		passwordKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		keyUsage,
	);

// for large strings, use this from https://stackoverflow.com/a/49124600
const buffToBase64 = (buff: ArrayBuffer) =>
	btoa(
		new Uint8Array(buff).reduce(
			(data, byte) => data + String.fromCharCode(byte),
			'',
		),
	);

const base64ToBuf = (b64: string) =>
	Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// returns base64 encoded string
export async function encrypt(
	secretData: string,
	password: string,
): Promise<string> {
	try {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const passwordKey = await getPasswordKey(password);
		const aesKey = await deriveKey(passwordKey, salt, ['encrypt']);
		const encryptedContent = await crypto.subtle.encrypt(
			{
				name: 'AES-GCM',
				iv: iv,
			},
			aesKey,
			enc.encode(secretData),
		);

		const encryptedContentArr = new Uint8Array(encryptedContent);

		let buff = new Uint8Array(
			salt.byteLength + iv.byteLength + encryptedContentArr.byteLength,
		);
		buff.set(salt, 0);
		buff.set(iv, salt.byteLength);
		buff.set(encryptedContentArr, salt.byteLength + iv.byteLength);

		const base64Buff = buffToBase64(buff);
		return base64Buff;
	} catch (e) {
		throw e;
	}
}

export async function decrypt(
	encryptedData: string,
	password: string,
): Promise<string> {
	try {
		const encryptedDataBuff = base64ToBuf(encryptedData);

		const salt = encryptedDataBuff.slice(0, 16);
		const iv = encryptedDataBuff.slice(16, 16 + 12);
		const data = encryptedDataBuff.slice(16 + 12);

		const passwordKey = await getPasswordKey(password);
		const aesKey = await deriveKey(passwordKey, salt, ['decrypt']);
		const decryptedContent = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: iv,
			},
			aesKey,
			data,
		);
		return dec.decode(decryptedContent);
	} catch (e) {
		throw e;
	}
}
