const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICES = {
  monthly: 'price_1TLUo1Ka2ZfgFcZ5T1KgF6PC',
  annual: 'price_1TLUo1Ka2ZfgFcZ568YFSZJA',
  lifetime: 'price_1TLUo3Ka2ZfgFcZ5WJ7Lt5bT'
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { plan, uid, email } = JSON.parse(event.body);

    if (!plan || !uid || !email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing plan, uid, or email' }) };
    }

    const priceId = PRICES[plan];
    if (!priceId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid plan' }) };
    }

    const isLifetime = plan === 'lifetime';
    const siteUrl = process.env.URL || 'https://cuecard.studio';

    const sessionConfig = {
      payment_method_types: ['card'],
      client_reference_id: uid,
      customer_email: email,
      success_url: siteUrl + '?checkout=success',
      cancel_url: siteUrl + '?checkout=cancel',
      metadata: { firebaseUid: uid, plan: plan },
      line_items: [{ price: priceId, quantity: 1 }]
    };

    if (isLifetime) {
      sessionConfig.mode = 'payment';
    } else {
      sessionConfig.mode = 'subscription';
      sessionConfig.subscription_data = {
        trial_period_days: 14,
        metadata: { firebaseUid: uid, plan: plan }
      };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url })
    };
  } catch (err) {
    console.error('Checkout error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
