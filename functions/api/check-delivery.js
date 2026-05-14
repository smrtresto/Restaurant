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
    const { pincode, area, sub_area, subtotal } = await request.json();
    if (!pincode || !area) {
      return new Response(JSON.stringify({ available: false, message: 'Pincode and area required' }), { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    let query = supabase
      .from('delivery_zones')
      .select('*')
      .eq('pincode', pincode)
      .eq('area', area)
      .eq('is_active', true);
    
    if (sub_area) query = query.eq('sub_area', sub_area);
    const { data: zones, error } = await query.limit(1);

    if (error || !zones || zones.length === 0) {
      return new Response(JSON.stringify({ available: false, message: 'Delivery not available to this location' }), { status: 200, headers: corsHeaders });
    }
    const zone = zones[0];

    // Time check (Forcing IST securely)
    const dateInIndia = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const currentTime = `${dateInIndia.getHours().toString().padStart(2,'0')}:${dateInIndia.getMinutes().toString().padStart(2,'0')}`;
    
    if (currentTime < zone.active_from || currentTime > zone.active_to) {
      return new Response(JSON.stringify({ available: false, message: `Delivery available only between ${zone.active_from.slice(0,5)} – ${zone.active_to.slice(0,5)} (IST)` }), { status: 200, headers: corsHeaders });
    }

    // Day check
    const dayOfWeek = dateInIndia.getDay();
    let isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
    const activeDays = zone.active_days.split(',').map(d => parseInt(d));
    if (!activeDays.includes(isoDay)) {
      return new Response(JSON.stringify({ available: false, message: 'Delivery not available on this day' }), { status: 200, headers: corsHeaders });
    }

    let finalCharge = zone.base_delivery_charge;
    let saved = 0;
    if (zone.offer_delivery_charge !== null) {
      if (subtotal >= zone.min_order_for_offer) {
        finalCharge = zone.offer_delivery_charge;
        saved = zone.base_delivery_charge - finalCharge;
      }
    }

    let message = `Delivery charge ₹${finalCharge}`;
    if (finalCharge === 0 && saved > 0) message = 'Free Delivery!';
    else if (saved > 0) message = `Delivery ₹${finalCharge} (was ₹${zone.base_delivery_charge})`;

    return new Response(JSON.stringify({
      available: true,
      charge: finalCharge,
      base_charge: zone.base_delivery_charge,
      offer_delivery_charge: zone.offer_delivery_charge,
      min_order_for_offer: zone.min_order_for_offer,
      saved_amount: saved,
      message,
      time_window: `${zone.active_from.slice(0,5)} – ${zone.active_to.slice(0,5)}`,
      estimated_time: zone.estimated_time
    }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ available: false, message: 'Server error' }), { status: 500, headers: corsHeaders });
  }
}