import { identitytoolkit_v3 } from '@googleapis/identitytoolkit';
import { AdminAuthApiClient, ServiceAccountCredential } from 'firebase-auth-cloudflare-workers';

async function getAccountInfo(
	token: string,
	publicFirebaseKey: string,
): Promise<identitytoolkit_v3.Schema$GetAccountInfoResponse | null> {
	// https://cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/lookup
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
	return await response.json();
}

export default {
  async getUid(
    token: string,
    publicFirebaseKey: string,
  ): Promise<string | null> {
    const data = await getAccountInfo(token, publicFirebaseKey);
    return data && data.users && data.users.length > 0 && data.users[0].localId ? data.users[0].localId! : null;
  },

  async getClaims(
    token: string,
    publicFirebaseKey: string,
  ) {
    const data = await getAccountInfo(token, publicFirebaseKey);
    if (!data || !data.users || data.users.length === 0) return false;
    const user = data.users[0];
    return JSON.parse(user.customAttributes ?? '{}');
  },

  Admin: {
    async getClaims(serviceAccount: string, authUserId: string) {
      const credential = new ServiceAccountCredential(serviceAccount);
      const auth = AdminAuthApiClient.getOrInitialize(
        credential.projectId,
        credential
      );
      const userRecord = await auth.getAccountInfoByUid(authUserId);
      return userRecord.customClaims;
    },
  
    async setClaims(serviceAccount: string, authUserId: string, claim: object) {
      const credential = new ServiceAccountCredential(serviceAccount);
      const auth = AdminAuthApiClient.getOrInitialize(
        credential.projectId,
        credential
      );
      await auth.setCustomUserClaims(authUserId, claim);
    }
  }

}