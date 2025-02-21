import { createClient } from '@supabase/supabase-js';

export default {
  async getUid(
    jwt: string,
    publicSupabaseKey: string,
    authAppId: string,
  ): Promise<string | null> {
    const supabase = createClient(authAppId, publicSupabaseKey);
    const { data: { user }, error } = await supabase.auth.getUser(jwt);
    if (error) {
      console.error('Token verification failed:', error.message);
      return null;
    }
    return user?.id ?? null;
  }
}
