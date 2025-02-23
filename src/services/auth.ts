import firebase from './gateways/firebase';
import supabase from './gateways/supabase';
import { ApiProxy, AuthProviderType, AuthHeader } from './repos/models';

export default {

	async getUid(jwt: string, apiProxy: ApiProxy): Promise<string | null> {
		let uid: string | null = null;
		try {
			if (apiProxy.authType === AuthProviderType.FIREBASE) {
				uid = await firebase.getUid(jwt, apiProxy.authPublicKey);
			} else if (apiProxy.authType === AuthProviderType.SUPABASE) {
				uid = await supabase.getUid(
					jwt,
					apiProxy.authPublicKey,
					apiProxy.authAppId,
				);
			}
		} catch (error: any) {
			console.error(error);
		}
		return uid;
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
