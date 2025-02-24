import { identitytoolkit_v3 } from '@googleapis/identitytoolkit';
import { AdminAuthApiClient, ServiceAccountCredential } from 'firebase-auth-cloudflare-workers';
import { CustomClaims } from '../repos/models';

// https://github.com/firebase/firebase-admin-node/blob/master/src/auth/auth-api-request.ts
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
    async getClaims(serviceAccount: string, uid: string) {
      const credential = new ServiceAccountCredential(serviceAccount);
      const auth = AdminAuthApiClient.getOrInitialize(
        credential.projectId,
        credential
      );
      const userRecord = await auth.getAccountInfoByUid(uid);
      return userRecord.customClaims;
    },
  
    async setClaims(serviceAccount: string, uid: string, claims: object) {
      const credential = new ServiceAccountCredential(serviceAccount);
      const auth = AdminAuthApiClient.getOrInitialize(
        credential.projectId,
        credential
      );
      await auth.setCustomUserClaims(uid, claims);
    },

    async getAllUsersClaims(serviceAccount: string): Promise<CustomClaims[]> {
      const credential = new ServiceAccountCredential(serviceAccount);
      const jwt = (await credential.getAccessToken()).access_token;
      const allUsers = [];
      let nextPageToken: string | undefined;
      do {
        const url = new URL(`https://identitytoolkit.googleapis.com/v1/projects/${credential.projectId}/accounts:batchGet`);
        if (nextPageToken) {
          url.searchParams.append('nextPageToken', nextPageToken);
        }
        url.searchParams.append('maxResults', '1000'); // Maximum allowed value

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${jwt}`,
          },
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to fetch users: ${response.statusText} - ${error}`);
        }

        const data: identitytoolkit_v3.Schema$DownloadAccountResponse = await response.json();
        if (data.users) {
          allUsers.push(...data.users);
        }
        nextPageToken = data.nextPageToken ?? undefined;
      } while (nextPageToken);
      return allUsers
        .filter(user => user.customAttributes && user.customAttributes !== '{}')
        .map((user) => ({uid: user.localId!, ...JSON.parse(user.customAttributes!)}));
    },
  }
}