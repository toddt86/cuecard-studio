const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function setProStatus(uid, plan, customerId) {
  await db.collection('users').doc(uid).collection('settings').doc('prefs').set({
    pro: true,
    proType: plan,
    proSince: admin.firestore.FieldValue.serverTimestamp(),
    stripeCustomerId: customerId || null
  }, { merge: true });
  console.log('Pro status set for user:', uid, 'plan:', plan);
}

async function removeProStatus(customerId) {
  // Find user by stripeCustomerId
  const usersRef = db.collectionGroup('settings');
  // We need to search differently since collectionGroup on subcollections is tricky
  // Instead, search the top-level path
  const snapshot = await db.collection('users').get();
  for (const userDoc of snapshot.docs) {
    const prefsDoc = await userDoc.ref.collection('settings').doc('prefs').get();
    if (prefsDoc.exists && prefsDoc.data().stripeCustomerId === customerId) {
      await prefsDoc.ref.set({ pro: false, proType: null }, { merge: true });
      console.log('Pro status removed for user:', userDoc.id);
      return;
    }
  }
  console.log('Could not find user for customer:', customerId);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: 'Webhook signature verification failed' };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const uid = session.metadata?.firebaseUid || session.client_reference_id;
        const plan = session.metadata?.plan || 'monthly';
        const customerId = session.customer;

        if (uid) {
          await setProStatus(uid, plan, customerId);
        } else {
          console.error('No Firebase UID found in session');
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        const uid = subscription.metadata?.firebaseUid;
        const customerId = subscription.customer;

        if (uid) {
          await db.collection('users').doc(uid).collection('settings').doc('prefs').set(
            { pro: false, proType: null }, { merge: true }
          );
          console.log('Subscription cancelled for user:', uid);
        } else if (customerId) {
          await removeProStatus(customerId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        const uid = invoice.subscription_details?.metadata?.firebaseUid;
        if (uid) {
          console.log('Payment failed for user:', uid);
          // Don't immediately revoke - Stripe retries. Revoke on subscription.deleted.
        }
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: 'Webhook handler error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
