import { User } from '@supabase/auth-js';
import { CustomClaims } from '../repos/models';

export default {
  async getUid(
    jwt: string,
    publicSupabaseKey: string,
    authAppId: string,
  ): Promise<string | null> {
    // in supabase this case the authAppId is the project or app url
    // https://naxywnoolzuwzkinwekg.supabase.co
    const response = await fetch(`${authAppId}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: publicSupabaseKey,
      },
    });
    if (!response.ok) {
      console.error('Token verification failed:', await response.text());
      return null;
    }
    const userData: User = await response.json();
    return userData.id;
  },
    Admin: {
    async getClaims({serviceRoleKey, projectUrl, uid}: {serviceRoleKey: string, projectUrl: string, uid: string}): Promise<CustomClaims> {
      const response = await fetch(`${projectUrl}/auth/v1/admin/users/${uid}`, {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to get user claims: ${response.statusText} - ${await response.text()}`);
      }
      const userData: User = await response.json();
      return userData.user_metadata || null;
    },

    async setClaims({serviceRoleKey, projectUrl, uid, claims}: {serviceRoleKey: string, projectUrl: string, uid: string, claims: CustomClaims}): Promise<void> {
      // Get existing metadata
      const response = await fetch(`${projectUrl}/auth/v1/admin/users/${uid}`, {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to get user data: ${response.statusText} - ${error}`);
      }
      const userData: User = await response.json();
      
      // Create new metadata object, preserving only non-claim fields
      const newMetadata = { ...userData.user_metadata };
      // Remove existing claim fields
      delete newMetadata.stripe_subs;
      // Add new claims if they exist
      Object.assign(newMetadata, claims['stripe_subs']);
      // Update with nullified fields first to clear everything
      const clearResponse = await fetch(`${projectUrl}/auth/v1/admin/users/${uid}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_metadata: newMetadata,
        }),
      });
      if (!clearResponse.ok) {
        const error = await clearResponse.text();
        throw new Error(`Failed to clear user claims: ${clearResponse.statusText} - ${error}`);
      }

      // Then set new claims if any exist
      if (Object.keys(claims).length > 0) {
        const updateResponse = await fetch(`${projectUrl}/auth/v1/admin/users/${uid}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_metadata: claims,
          }),
        });
        if (!updateResponse.ok) {
          const error = await updateResponse.text();
          throw new Error(`Failed to set user claims: ${updateResponse.statusText} - ${error}`);
        }
      }
    },

    async getAllUsersClaims({serviceRoleKey, projectUrl}: {serviceRoleKey: string, projectUrl: string}): Promise<CustomClaims[]> {
      const allUsers: User[] = [];
      let page = 1;
      const perPage = 1000;
      while (true) {
        const response = await fetch(
          `${projectUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, 
          {
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
            },
          }
        );
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to fetch users: ${response.statusText} - ${error}`);
        }
        const users: User[] = await response.json();
        if (!users || users.length === 0) break;
        
        allUsers.push(...users);
        if (users.length < perPage) break;
        page++;
      }
      return allUsers
        .filter(user => user.user_metadata && Object.keys(user.user_metadata).length > 0)
        .map(user => ({uid: user.id, ...user.user_metadata}));
    }
  }
}