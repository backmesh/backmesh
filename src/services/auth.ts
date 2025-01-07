import { ApiProxy, AuthProviderType } from './kv';

export type AuthHeader = {
	field: string;
	value: string;
	extractedJwt: string;
};

export async function firebaseUidFromJwt(
	token: string,
	publicFirebaseKey: string,
): Promise<string | null> {
	const response = await fetch(
		`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${publicFirebaseKey}`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				idToken: token,
			}),
		},
	);

	if (!response.ok) {
		console.error('Error verifying ID token:', response.statusText);
		return null;
	}

	// TODO import firebase types?
	interface FirebaseResponse {
		users?: { localId: string }[];
	}
	const data: FirebaseResponse = await response.json();
	return data && data.users && data.users.length > 0 ? data.users[0].localId : null;
}

export async function supabaseUidFromJwt(
	token: string,
	publicSupabaseKey: string,
	authAppId: string,
): Promise<string | null> {
	// in supabase this case the authAppId is the project or app url
	// https://naxywnoolzuwzkinwekg.supabase.co
	const response = await fetch(`${authAppId}/auth/v1/user`, {
		headers: {
			Authorization: `Bearer ${token}`,
			apikey: publicSupabaseKey,
		},
	});

	if (!response.ok) {
		console.error('Token verification failed:', await response.text());
		return null;
	}

	const userData: SupabaseUserData = await response.json();

	// TODO import supabase types?
	interface SupabaseUserData {
		id: string;
	}
	return userData.id;
}

export default {
	firebaseUidFromJwt,

	async getUidFromJwt(token: string, apiProxy: ApiProxy): Promise<string | null> {
		let jwt: string | null = null;
		try {
			if (apiProxy.authType === AuthProviderType.FIREBASE) {
				jwt = await firebaseUidFromJwt(token, apiProxy.authPublicKey);
			} else if (apiProxy.authType === AuthProviderType.SUPABASE) {
				jwt = await supabaseUidFromJwt(
					token,
					apiProxy.authPublicKey,
					apiProxy.authAppId,
				);
			}
		} catch (error: any) {
			console.error(error);
		}
		return jwt;
	},

	getAuthHeader(request: Request, apiReqHeader: string): AuthHeader | null {
		const val = request.headers.get(apiReqHeader);
		if (!val) return null;
		const parts = val.split(' ');
		if (parts.length > 2) return null; // wtf
		return {
			field: apiReqHeader,
			value: val,
			extractedJwt: parts.length === 2 ? parts[1] : parts[0],
		};
	},

	newProxyHeaders(request: Request, header: AuthHeader, apiKey: string): Headers {
		const headers = new Headers(request.headers);
		headers.set(header.field, header.value.replace(header.extractedJwt, apiKey));
		if (!headers.has('Content-Type')) {
			headers.set('Content-Type', 'application/json');
		}
		return headers;
	},
};
