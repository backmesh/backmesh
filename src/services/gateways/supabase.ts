import { User } from '@supabase/supabase-js';

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
  }
}
