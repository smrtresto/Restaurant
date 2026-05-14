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
      customer_name, customer_phone, customer_address, cart, total, payment_method,
      orderId, coupon_code, pincode, area, sub_area, cooking_instructions
    } = body;
    
    const userId = user.id;

    if (!userId || !customer_name || !customer_phone || !customer_address || !cart || !cart.length) {
      return new Response(JSON.stringify({ error: 'Missing required fields or empty cart' }), { status: 400, headers: corsHeaders });
    }
    if (!orderId) return new Response(JSON.stringify({ error: 'Missing orderId' }), { status: 400, headers: corsHeaders });

    // --- SERVER-SIDE VALIDATION ---
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
      const { data: coupon, error: couponError } = await supabase.from('discounts').select('*').eq('code', coupon_code.toUpperCase()).eq('is_active', true).single();
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
      let query = supabase.from('delivery_zones').select('*').eq('pincode', pincode).eq('area', area).eq('is_active', true);
      if (sub_area) query = query.eq('sub_area', sub_area);
      const { data: zones } = await query.limit(1);
      
      if (zones && zones.length > 0) {
        const zone = zones[0];
        const dateInIndia = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const currentTime = `${dateInIndia.getHours().toString().padStart(2,'0')}:${dateInIndia.getMinutes().toString().padStart(2,'0')}`;
        
        if (currentTime < zone.active_from || currentTime > zone.active_to) {
          return new Response(JSON.stringify({ error: `Delivery closed. Operating hours: ${zone.active_from.slice(0,5)} - ${zone.active_to.slice(0,5)} IST` }), { status: 400, headers: corsHeaders });
        }
        const dayOfWeek = dateInIndia.getDay();
        let isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
        const activeDays = zone.active_days.split(',').map(d => parseInt(d));
        if (!activeDays.includes(isoDay)) return new Response(JSON.stringify({ error: 'Delivery not available today' }), { status: 400, headers: corsHeaders });

        serverEstimatedTime = zone.estimated_time || null;
        serverBaseCharge = zone.base_delivery_charge;
        serverDeliveryCharge = serverBaseCharge;
        const actualAmount = serverSubtotal - serverOfferDiscount;
        if (zone.offer_delivery_charge !== null && actualAmount >= zone.min_order_for_offer) {
          serverDeliveryCharge = zone.offer_delivery_charge;
        }
      } else {
        return new Response(JSON.stringify({ error: 'Delivery not available to this location' }), { status: 400, headers: corsHeaders });
      }
    }

    let beforeDeliveryTotal = serverSubtotal - serverOfferDiscount - serverCouponDiscount;
    if (beforeDeliveryTotal < 0) beforeDeliveryTotal = 0;
    const serverTotal = beforeDeliveryTotal + serverDeliveryCharge;
    
    if (Math.abs(serverTotal - Number(total)) > 1) {
      return new Response(JSON.stringify({ error: 'Order total mismatch. Please refresh your cart.' }), { status: 400, headers: corsHeaders });
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

    const { data, error } = await supabase
      .from('orders')
      .insert({
        user_id: userId, order_id: orderId, total_amount: serverTotal,
        customer_name, customer_phone, customer_address, payment_status: 'pending',
        order_status: 'received', payment_method: payment_method || 'cod',
        cart_items: secureCartItems, status_log: statusLog,
        subtotal: serverSubtotal, offer_discount: serverOfferDiscount,
        coupon_discount: serverCouponDiscount, base_delivery_charge: serverBaseCharge,
        applied_delivery_charge: serverDeliveryCharge, tax: 0,
        coupon_code: coupon_code || null,
        customer_pincode: pincode, customer_area: area, customer_sub_area: sub_area || null,
        cooking_instructions: cooking_instructions || null
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }

    if (coupon_code) {
      await supabase.rpc('increment_coupon_usage', { coupon_code });
    }

    return new Response(JSON.stringify({ success: true, orderId: data.order_id }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}