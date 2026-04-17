// netlify/functions/_shared/access.js
// Shared auth + subscription + daily rate-limit gate for Perplexity-powered
// paid features. Used by generate-script, trending-topics, and fact-check.
// Importable from both CJS and ESM callers.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

// Daily limits per tier, counted across all Perplexity features combined.
// See docs/FEATURE_SPEC.md.
const TIER_DAILY_LIMITS = {
  monthly: 30,
  annual: 100,
  lifetime: 100
};

// Custom error so callers can switch on statusCode and payload.
class AccessError extends Error {
  constructor(statusCode, payload) {
    super(typeof payload === 'string' ? payload : (payload && payload.error) || 'Access error');
    this.statusCode = statusCode;
    this.payload = typeof payload === 'string' ? { error: payload } : payload;
  }
}

// UTC day key so all users roll over at the same moment regardless of tz.
function utcDayKey(date) {
  const d = date || new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function verifyUser(idToken) {
  if (!idToken) throw new AccessError(401, { error: 'Missing auth token' });
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (e) {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }
}

// Single atomic check-and-increment. Reads the user's pro status, figures out
// their daily limit, and either increments usage or throws 429.
// Returns { tier, limit, used, dayKey } on success.
async function requireProAndConsumeQuota(uid) {
  const db = admin.firestore();
  const prefsRef = db.doc(`users/${uid}/settings/prefs`);
  const prefsSnap = await prefsRef.get();
  const prefs = prefsSnap.exists ? prefsSnap.data() : {};

  if (!prefs.pro) {
    throw new AccessError(403, { error: 'Pro subscription required', upgrade: true });
  }

  const tier = prefs.proType || 'monthly';
  const limit = TIER_DAILY_LIMITS[tier] || TIER_DAILY_LIMITS.monthly;
  const dayKey = utcDayKey();
  const usageRef = db.doc(`users/${uid}/usage/${dayKey}`);

  // Transaction ensures concurrent calls cannot race past the limit.
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const current = snap.exists ? (snap.data().count || 0) : 0;

    if (current >= limit) {
      throw new AccessError(429, {
        error: "You've hit today's generation limit. Resets at midnight UTC.",
        limit,
        used: current,
        resetAt: 'midnight UTC'
      });
    }

    tx.set(usageRef, {
      count: current + 1,
      date: dayKey,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return { tier, limit, used: current + 1, dayKey };
  });

  return result;
}

// Helper to unwrap an AccessError into a Netlify Functions v1 response object.
function errorResponse(err) {
  if (err instanceof AccessError) {
    return {
      statusCode: err.statusCode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(err.payload)
    };
  }
  console.error('Unexpected access error:', err);
  return {
    statusCode: 500,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'Server error' })
  };
}

module.exports = {
  admin,
  AccessError,
  TIER_DAILY_LIMITS,
  utcDayKey,
  verifyUser,
  requireProAndConsumeQuota,
  errorResponse
};
