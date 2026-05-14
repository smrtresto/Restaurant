// supabase.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://tvuvjpwfyhtyfozzbxlw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_17Wo7UFYkSLdOi6Zcectvg_46SUUEhC';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    storage: localStorage,
    detectSessionInUrl: true
  }
});