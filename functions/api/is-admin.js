import { createClient } from '@supabase/supabase-js';

export async function onRequest(context) {
  const { request, env } = context;
  
  // CORS Headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ admin: false, error: 'No token' }), { status: 401, headers: corsHeaders });
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return new Response(JSON.stringify({ admin: false, error: 'Invalid token' }), { status: 401, headers: corsHeaders });
    }

    const { data, error: dbError } = await supabase
      .from('admin_users')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (dbError) {
      console.error(dbError);
      return new Response(JSON.stringify({ admin: false, error: 'Database error' }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ admin: !!data, user: user.email }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ admin: false, error: err.message }), { status: 500, headers: corsHeaders });
  }
}