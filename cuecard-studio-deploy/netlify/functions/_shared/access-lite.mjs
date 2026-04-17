// _shared/access-lite.mjs
// Auth + subscription + daily rate-limit gate for Perplexity-powered paid
// features, implemented with ONLY Node built-ins + fetch. No firebase-admin.
//
// Why the rewrite: Netlify's ESM v2 bundler (esbuild) could not ship
// firebase-admin alongside generate-script.mjs, so every call crashed with
// MODULE_NOT_FOUND. This file uses Node's `crypto` to verify Firebase ID
// tokens against Google's public certs and hits the Firestore REST API with
// a service-account OAuth token. Pure JS, bundles cleanly.
//
// Mirrors the API surface of _shared/access.js (CJS, used by other functions)
// so future callers can pick either without changing their code.

import crypto from 'node:crypto';

const TIER_DAILY_LIMITS = { monthly: 30, annual: 100, lifetime: 100 };
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const CLOCK_SKEW_SEC = 60;

class AccessError extends Error {
  constructor(statusCode, payload) {
    super(typeof payload === 'string' ? payload : (payload && payload.error) || 'Access error');
    this.statusCode = statusCode;
    this.payload = typeof payload === 'string' ? { error: payload } : payload;
  }
}

// ---------- base64url helpers ----------

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  return Buffer.from(s + '='.repeat(pad), 'base64');
}

function b64urlEncode(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(bufOrStr);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- misc ----------

function utcDayKey(date) {
  const d = date || new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------- Service account (lazy, cached) ----------

let _sa = null;
function serviceAccount() {
  if (_sa) return _sa;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var missing');
    throw new AccessError(500, { error: 'Server misconfigured' });
  }
  try {
    _sa = JSON.parse(raw);
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    throw new AccessError(500, { error: 'Server misconfigured' });
  }
  if (!_sa.project_id || !_sa.client_email || !_sa.private_key) {
    console.error('FIREBASE_SERVICE_ACCOUNT missing required fields');
    throw new AccessError(500, { error: 'Server misconfigured' });
  }
  return _sa;
}

function getProjectId() {
  return serviceAccount().project_id;
}

// ---------- Google public certs (cached per max-age) ----------

let _certs = null; // { fetchedAt, expiresAt, map }

async function getGoogleCerts() {
  const now = Date.now();
  if (_certs && _certs.expiresAt > now) return _certs.map;

  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) {
    console.error('Fetch Google certs failed:', res.status);
    throw new AccessError(502, { error: 'Could not reach auth server' });
  }
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const ttl = (m ? parseInt(m[1], 10) : 3600) * 1000;
  const map = await res.json();
  _certs = { fetchedAt: now, expiresAt: now + ttl, map };
  return map;
}

// ---------- Verify Firebase ID token ----------

async function verifyUser(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new AccessError(401, { error: 'Missing auth token' });
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }

  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }

  const projectId = getProjectId();
  const now = Math.floor(Date.now() / 1000);

  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }
  if (payload.aud !== projectId) {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }
  if (typeof payload.exp !== 'number' || payload.exp < now - CLOCK_SKEW_SEC) {
    throw new AccessError(401, { error: 'Auth token expired' });
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + CLOCK_SKEW_SEC) {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }
  if (typeof payload.auth_time === 'number' && payload.auth_time > now + CLOCK_SKEW_SEC) {
    throw new AccessError(401, { error: 'Invalid auth token' });
  }

  const certs = await getGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new AccessError(401, { error: 'Invalid auth token' });

  let ok;
  try {
    const pubKey = crypto.createPublicKey(pem);
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = b64urlDecode(parts[2]);
    ok = crypto.verify('RSA-SHA256', signingInput, pubKey, signature);
  } catch (e) {
    console.error('Token signature verify threw:', e.message);
    throw new AccessError(401, { error: 'Invalid auth token' });
  }
  if (!ok) throw new AccessError(401, { error: 'Invalid auth token' });

  return payload.sub;
}

// ---------- Service-account access token (cached) ----------

let _token = null; // { token, expiresAt }

async function getAccessToken() {
  const nowMs = Date.now();
  if (_token && _token.expiresAt > nowMs + 60_000) return _token.token;

  const sa = serviceAccount();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: OAUTH_TOKEN_URL,
    scope: FIRESTORE_SCOPE,
    iat,
    exp
  };
  const unsigned = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(claims))}`;
  const privateKey = crypto.createPrivateKey(sa.private_key);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey);
  const assertion = `${unsigned}.${b64urlEncode(sig)}`;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  });

  if (!res.ok) {
    const t = await res.text();
    console.error('OAuth token exchange failed:', res.status, t.slice(0, 300));
    throw new AccessError(500, { error: 'Server error' });
  }
  const json = await res.json();
  _token = {
    token: json.access_token,
    expiresAt: nowMs + (json.expires_in * 1000)
  };
  return _token.token;
}

// ---------- Firestore REST helpers ----------

function firestoreUrl(pathOrOp, params) {
  const projectId = getProjectId();
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  if (pathOrOp.startsWith(':')) {
    // e.g. ':beginTransaction' hits documents:beginTransaction
    return `${base}${pathOrOp}${qs}`;
  }
  return `${base}/${pathOrOp}${qs}`;
}

async function firestoreRequest(url, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  return fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

// Convert a Firestore "fields" object into a plain JS object. Only handles
// the types we actually store.
function unwrapFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue, 10);
    else if (v.doubleValue !== undefined) out[k] = v.doubleValue;
    else if (v.nullValue !== undefined) out[k] = null;
    else out[k] = v;
  }
  return out;
}

// ---------- Main: check pro + atomically consume quota ----------

async function requireProAndConsumeQuota(uid) {
  const projectId = getProjectId();
  const prefsPath = `users/${uid}/settings/prefs`;
  const dayKey = utcDayKey();
  const usagePath = `users/${uid}/usage/${dayKey}`;
  const usageDocName =
    `projects/${projectId}/databases/(default)/documents/${usagePath}`;

  // 1. Read prefs to check pro status. (Non-transactional read is fine
  //    because a pro flag flipping mid-request just means the user should
  //    be gated — we re-check next call.)
  const prefsRes = await firestoreRequest(firestoreUrl(prefsPath));
  let prefs = {};
  if (prefsRes.status === 200) {
    const data = await prefsRes.json();
    prefs = unwrapFields(data.fields);
  } else if (prefsRes.status !== 404) {
    const t = await prefsRes.text();
    console.error('Firestore prefs read failed:', prefsRes.status, t.slice(0, 200));
    throw new AccessError(500, { error: 'Server error' });
  }

  if (!prefs.pro) {
    throw new AccessError(403, { error: 'Pro subscription required', upgrade: true });
  }

  const tier = prefs.proType || 'monthly';
  const limit = TIER_DAILY_LIMITS[tier] || TIER_DAILY_LIMITS.monthly;

  // 2. Begin a read-write transaction so concurrent calls cannot race past
  //    the daily limit.
  const beginRes = await firestoreRequest(firestoreUrl(':beginTransaction'), {
    method: 'POST',
    body: { options: { readWrite: {} } }
  });
  if (!beginRes.ok) {
    const t = await beginRes.text();
    console.error('beginTransaction failed:', beginRes.status, t.slice(0, 200));
    throw new AccessError(500, { error: 'Server error' });
  }
  const { transaction } = await beginRes.json();

  // 3. Read usage doc inside the transaction. 404 means "no generations yet
  //    today, current count = 0".
  const usageRes = await firestoreRequest(firestoreUrl(usagePath, { transaction }));
  let current = 0;
  if (usageRes.status === 200) {
    const data = await usageRes.json();
    const u = unwrapFields(data.fields);
    current = typeof u.count === 'number' ? u.count : 0;
  } else if (usageRes.status !== 404) {
    const t = await usageRes.text();
    console.error('Firestore usage read failed:', usageRes.status, t.slice(0, 200));
    // Best effort rollback and surface the error.
    await firestoreRequest(firestoreUrl(':rollback'), {
      method: 'POST',
      body: { transaction }
    });
    throw new AccessError(500, { error: 'Server error' });
  }

  if (current >= limit) {
    await firestoreRequest(firestoreUrl(':rollback'), {
      method: 'POST',
      body: { transaction }
    });
    throw new AccessError(429, {
      error: "You've hit today's generation limit. Resets at midnight UTC.",
      limit,
      used: current,
      resetAt: 'midnight UTC'
    });
  }

  // 4. Commit: set `date` + server-timestamp `updatedAt`, atomically
  //    increment `count`. Works for both "create" and "update" cases because
  //    Firestore's update with no preconditions upserts.
  const commitBody = {
    transaction,
    writes: [{
      update: {
        name: usageDocName,
        fields: { date: { stringValue: dayKey } }
      },
      updateMask: { fieldPaths: ['date'] },
      updateTransforms: [
        { fieldPath: 'count', increment: { integerValue: '1' } },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }
      ]
    }]
  };
  const commitRes = await firestoreRequest(firestoreUrl(':commit'), {
    method: 'POST',
    body: commitBody
  });
  if (!commitRes.ok) {
    const t = await commitRes.text();
    console.error('Firestore commit failed:', commitRes.status, t.slice(0, 300));
    throw new AccessError(500, { error: 'Server error' });
  }

  return { tier, limit, used: current + 1, dayKey };
}

export {
  AccessError,
  TIER_DAILY_LIMITS,
  utcDayKey,
  verifyUser,
  requireProAndConsumeQuota
};
