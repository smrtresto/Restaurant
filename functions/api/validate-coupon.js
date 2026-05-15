import { createClient } from '@supabase/supabase-js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const { code: rawCode, subtotal, userId } = await request.json();
    if (!rawCode) return new Response(JSON.stringify({ valid: false, message: 'Coupon code required' }), { status: 400, headers: corsHeaders });
    
    const code = String(rawCode).trim().toUpperCase();
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: coupon, error } = await supabase
      .from('discounts')
      .select('*')
      .eq('code', code)
      .single();

    if (error || !coupon) {
      return new Response(JSON.stringify({ valid: false, message: 'Invalid coupon code' }), { status: 200, headers: corsHeaders });
    }

    const now = new Date();
    const validFrom = new Date(coupon.valid_from);
    const validTo = new Date(coupon.valid_to);
    
    if (now < validFrom || (coupon.valid_to && now > validTo)) return new Response(JSON.stringify({ valid: false, message: 'Coupon expired' }), { status: 200, headers: corsHeaders });
    if (!coupon.is_active) return new Response(JSON.stringify({ valid: false, message: 'Coupon not active' }), { status: 200, headers: corsHeaders });
    if (subtotal < coupon.min_cart_value) return new Response(JSON.stringify({ valid: false, message: `Minimum order ₹${coupon.min_cart_value}` }), { status: 200, headers: corsHeaders });
    if (coupon.usage_limit && coupon.usage_count >= coupon.usage_limit) return new Response(JSON.stringify({ valid: false, message: 'Usage limit reached' }), { status: 200, headers: corsHeaders });
    
    if (userId && coupon.per_user_limit > 0) {
      const { count, error: countErr } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('coupon_code', code);
      if (!countErr && count >= coupon.per_user_limit) return new Response(JSON.stringify({ valid: false, message: 'You have already used this coupon' }), { status: 200, headers: corsHeaders });
    }

    let discountAmount = 0;
    if (coupon.discount_type === 'percentage') {
      discountAmount = (coupon.discount_value / 100) * subtotal;
      if (coupon.max_discount && discountAmount > coupon.max_discount) discountAmount = coupon.max_discount;
    } else {
      discountAmount = coupon.discount_value;
    }
    discountAmount = Math.min(discountAmount, subtotal);

    return new Response(JSON.stringify({ valid: true, discount_amount: discountAmount, code: coupon.code, message: 'Coupon applied' }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ valid: false, message: err.message }), { status: 500, headers: corsHeaders });
  }
}