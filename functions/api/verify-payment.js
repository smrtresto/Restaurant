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
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    
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
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      orderId, customer_name, customer_phone, customer_address, cart, total, payment_method,
      coupon_code, pincode, area, sub_area, cooking_instructions
    } = body;
    
    const userId = user.id;

    // Verify Signature
    const rzp = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
    const secret = env.RAZORPAY_KEY_SECRET;
    
    // In Workers, we can use the Web Crypto API or Node compatibility
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(razorpay_order_id + '|' + razorpay_payment_id);
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (expectedSignature !== razorpay_signature) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid signature' }), { status: 400, headers: corsHeaders });
    }

    // --- FINAL SERVER-SIDE RECALCULATION ---
    let serverSubtotal = 0;
    let serverOfferDiscount = 0;
    
    const itemIds = cart.map(item => item.id);
    const { data: menuItems, error: menuError } = await supabase.from('menu').select('id, name, price, offer_price, is_active, is_veg, image_url').in('id', itemIds);
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
      const { data: coupon } = await supabase.from('discounts').select('*').eq('code', coupon_code.toUpperCase()).eq('is_active', true).single();
      if (coupon && discountedSubtotal >= coupon.min_cart_value) {
        if (coupon.discount_type === 'percentage') {
          serverCouponDiscount = Math.min(discountedSubtotal * (coupon.discount_value / 100), coupon.max_discount || Infinity);
        } else {
          serverCouponDiscount = coupon.discount_value;
        }
        serverCouponDiscount = Math.min(serverCouponDiscount, discountedSubtotal);
      }
    }

    let serverDeliveryCharge = 0;
    let serverBaseCharge = 0;
    let serverEstimatedTime = null;
    if (pincode && area) {
      let query = supabase.from('delivery_zones').select('*').eq('pincode', pincode).eq('area', area).eq('is_active', true);
      if (sub_area) query = query.eq('sub_area', sub_area);
      const { data: zones } = await query.limit(1);
      if (zones && zones.length > 0) {
        serverEstimatedTime = zones[0].estimated_time || null;
        serverBaseCharge = zones[0].base_delivery_charge;
        serverDeliveryCharge = serverBaseCharge;
        const actualAmount = serverSubtotal - serverOfferDiscount;
        if (zones[0].offer_delivery_charge !== null && actualAmount >= zones[0].min_order_for_offer) {
          serverDeliveryCharge = zones[0].offer_delivery_charge;
        }
      }
    }

    let beforeDeliveryTotal = serverSubtotal - serverOfferDiscount - serverCouponDiscount;
    if (beforeDeliveryTotal < 0) beforeDeliveryTotal = 0;
    const serverTotal = beforeDeliveryTotal + serverDeliveryCharge;

    // Verify amount via Razorpay API
    let payment;
    try {
      payment = await rzp.payments.fetch(razorpay_payment_id);
    } catch (rzpErr) {
      console.error('Razorpay fetch error:', rzpErr);
      return new Response(JSON.stringify({ success: false, error: 'Could not fetch payment details from Razorpay' }), { status: 400, headers: corsHeaders });
    }

    if (payment.amount !== Math.round(serverTotal * 100)) {
       return new Response(JSON.stringify({ success: false, error: `Amount mismatch. Paid ₹${payment.amount/100}, expected ₹${serverTotal}` }), { status: 400, headers: corsHeaders });
    }

    const statusLog = { 
      received: new Date().toISOString(),
      estimated_time: serverEstimatedTime
    };
    const secureCartItems = cart.map(item => {
      const dbItem = menuItems.find(m => m.id === item.id);
      const effectivePrice = (dbItem.offer_price && dbItem.offer_price < dbItem.price) ? dbItem.offer_price : dbItem.price;
      return {
        id: item.id,
        name: dbItem.name,
        price: effectivePrice,
        original_price: dbItem.price,
        quantity: item.quantity,
        is_veg: dbItem.is_veg,
        image_url: dbItem.image_url || null
      };
    });

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        user_id: userId, order_id: orderId, total_amount: serverTotal,
        razorpay_order_id, customer_name, customer_phone, customer_address,
        payment_status: 'paid', order_status: 'received',
        payment_method: payment_method || 'online', cart_items: secureCartItems,
        status_log: statusLog,
        subtotal: serverSubtotal, offer_discount: serverOfferDiscount,
        coupon_discount: serverCouponDiscount, base_delivery_charge: serverBaseCharge,
        applied_delivery_charge: serverDeliveryCharge, tax: 0,
        coupon_code: coupon_code || null,
        customer_pincode: pincode, customer_area: area, customer_sub_area: sub_area || null,
        cooking_instructions: cooking_instructions || null
      })
      .select()
      .single();

    if (orderErr) throw orderErr;

    if (coupon_code) {
      await supabase.rpc('increment_coupon_usage', { coupon_code });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error('Final order processing error:', err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
  }
}