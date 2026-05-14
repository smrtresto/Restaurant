// supabase.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://ciixjaljoxrziyebmfuj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_rqQb3sXdRIBQKQ9j-BV76Q_2UeukIL3';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    storage: localStorage,
    detectSessionInUrl: true
  }
});