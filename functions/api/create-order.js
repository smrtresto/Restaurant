import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Missing token' }), { status: 401, headers: corsHeaders });
    }
    const token = authHeader.split(' ')[1];

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401, headers: corsHeaders });
    }

    const body = await request.json();
    const { 
      total, cart, coupon_code, pincode, area, sub_area
    } = body;

    if (!total || isNaN(total) || total <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid total' }), { status: 400, headers: corsHeaders });
    }

    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    
    let serverSubtotal = 0;
    let serverOfferDiscount = 0;
    
    const itemIds = cart.map(item => item.id);
    const { data: menuItems, error: menuError } = await supabaseAdmin.from('menu').select('id, price, offer_price, is_active, image_url').in('id', itemIds);
    if (menuError || !menuItems) throw new Error('Could not verify menu prices');

    for (const item of cart) {
      const dbItem = menuItems.find(m => m.id === item.id);
      if (!dbItem || !dbItem.is_active) throw new Error(`Item ${item.name} is no longer available`);
      const effectivePrice = (dbItem.offer_price && dbItem.offer_price < dbItem.price) ? dbItem.offer_price : dbItem.price;
      serverSubtotal += dbItem.price * item.quantity;
      serverOfferDiscount += (dbItem.price - effectivePrice) * item.quantity;
    }

    let serverCouponDiscount = 0;
    const discountedSubtotal = serverSubtotal - serverOfferDiscount;
    if (coupon_code) {
      const { data: coupon, error: couponError } = await supabaseAdmin.from('discounts').select('*').eq('code', coupon_code.toUpperCase()).eq('is_active', true).single();
      if (!couponError && coupon) {
        if (discountedSubtotal >= coupon.min_cart_value) {
          if (coupon.discount_type === 'percentage') {
            serverCouponDiscount = Math.min(discountedSubtotal * (coupon.discount_value / 100), coupon.max_discount || Infinity);
          } else {
            serverCouponDiscount = coupon.discount_value;
          }
          serverCouponDiscount = Math.min(serverCouponDiscount, discountedSubtotal);
        }
      }
    }

    let serverDeliveryCharge = 0;
    let serverBaseCharge = 0;
    let serverEstimatedTime = null;
    if (pincode && area) {
      let query = supabaseAdmin.from('delivery_zones').select('*').eq('pincode', pincode).eq('area', area).eq('is_active', true);
      if (sub_area) query = query.eq('sub_area', sub_area);
      const { data: zones } = await query.limit(1);
      
      if (zones && zones.length > 0) {
        const zone = zones[0];
        serverEstimatedTime = zone.estimated_time || null;
        
        const dateInIndia = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const currentTime = `${dateInIndia.getHours().toString().padStart(2,'0')}:${dateInIndia.getMinutes().toString().padStart(2,'0')}`;
        
        if (currentTime < zone.active_from || currentTime > zone.active_to) {
          throw new Error(`Delivery closed. Operating hours: ${zone.active_from.slice(0,5)} - ${zone.active_to.slice(0,5)} IST`);
        }
        const dayOfWeek = dateInIndia.getDay();
        let isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
        const activeDays = zone.active_days.split(',').map(d => parseInt(d));
        if (!activeDays.includes(isoDay)) throw new Error('Delivery not available today');

        serverBaseCharge = zone.base_delivery_charge;
        serverDeliveryCharge = serverBaseCharge;
        const actualAmount = serverSubtotal - serverOfferDiscount;
        if (zone.offer_delivery_charge !== null && actualAmount >= zone.min_order_for_offer) {
          serverDeliveryCharge = zone.offer_delivery_charge;
        }
      } else {
        throw new Error('Delivery not available to this location');
      }
    }

    let beforeDeliveryTotal = serverSubtotal - serverOfferDiscount - serverCouponDiscount;
    if (beforeDeliveryTotal < 0) beforeDeliveryTotal = 0;
    const serverTotal = beforeDeliveryTotal + serverDeliveryCharge;
    
    if (Math.abs(serverTotal - Number(total)) > 1) {
      return new Response(JSON.stringify({ error: `Order mismatch. Please refresh cart.` }), { status: 400, headers: corsHeaders });
    }

    const finalAmount = Math.round(serverTotal * 100);
    const rzp = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
    
    const shortUserId = user.id.slice(0, 8);
    const shortTimestamp = Date.now().toString().slice(-6);
    const receipt = `rcpt_${shortUserId}_${shortTimestamp}`;

    const razorOrder = await rzp.orders.create({
      amount: finalAmount,
      currency: 'INR',
      receipt: receipt,
    });

    return new Response(JSON.stringify(razorOrder), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error('Create-order error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}