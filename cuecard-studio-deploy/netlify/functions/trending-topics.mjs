// netlify/functions/trending-topics.mjs
// Feature 2: Trending Topics.
//
// POST endpoint that verifies the user, consumes a daily quota slot, and
// calls Perplexity `sonar` with search_recency_filter:'week' to find what's
// actually trending in the user's niche. Returns a JSON array of 5 items:
//
//   { headline, why_now, angle, source_urls[] }
//
// No streaming — we need the full response to validate JSON shape before
// sending it downstream, and sonar is fast enough (~3-6s) that streaming
// isn't worth the complexity.
//
// Telemetry: logs uid, niche (OK — niches are generic), count, latency,
// tokens, cost. Never the topic content.

import {
  verifyUser,
  requireProAndConsumeQuota,
  AccessError
} from './_shared/access-lite.mjs';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const MIN_COUNT = 3;
const MAX_NICHE_LEN = 120;

// sonar pricing: $1 per M input tokens, $1 per M output tokens.
function estimateCost(inputTokens, outputTokens) {
  const inCost = (inputTokens / 1_000_000) * 1;
  const outCost = (outputTokens / 1_000_000) * 1;
  return +(inCost + outCost).toFixed(5);
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function buildSystemPrompt() {
  return `You find stories that are trending RIGHT NOW in a given niche and return them as strict JSON.

You will be given a niche. Use this week's real news, data releases, launches, cultural moments, or industry developments in that niche. Not evergreen articles. Not things that trended last month.

For each story return an object with this EXACT shape:
{
  "headline": "short hook-style title under 80 chars, something that would stop a scroll — not the article's actual title",
  "why_now": "one sentence on what makes this trend-worthy THIS WEEK",
  "angle": "one sentence describing a narrative angle a creator could take",
  "source_urls": ["https://...", "https://..."]
}

Rules:
- Output ONLY a JSON array. No markdown. No code fences. No preamble. No closing remarks.
- Start with [ and end with ].
- Every URL must be real and reachable. No placeholders.
- Every source_urls array has 1 to 3 entries.
- Every field is a non-empty string (arrays non-empty).
- Headlines must grab attention. Avoid corporate cliches.
- If the niche is vague or niche is misspelled, still return 5 best-guess stories.`;
}

function buildUserPrompt(niche, count) {
  return `Find ${count} stories trending this week in this niche: ${niche}

Return a JSON array as specified. Start with [ and end with ]. No other text.`;
}

// Models occasionally add wrappers despite being told not to. Strip fences,
// strip any preamble before the first [, strip any chatter after the last ].
function extractJsonArray(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeTopic(t) {
  if (!t || typeof t !== 'object') return null;
  const headline = typeof t.headline === 'string' ? t.headline.trim() : '';
  const why_now  = typeof t.why_now  === 'string' ? t.why_now.trim()  : '';
  const angle    = typeof t.angle    === 'string' ? t.angle.trim()    : '';
  const sources = Array.isArray(t.source_urls)
    ? t.source_urls.filter(u => typeof u === 'string' && isValidHttpUrl(u))
    : [];
  if (!headline || !why_now || !angle || sources.length === 0) return null;
  return {
    headline: headline.slice(0, 160),
    why_now:  why_now.slice(0, 300),
    angle:    angle.slice(0, 300),
    source_urls: sources.slice(0, 3)
  };
}

// Call Perplexity with the same retry policy as generate-script: exponential
// backoff on 429/5xx, never retry on 401.
async function callPerplexityWithRetry(body, apiKey) {
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(PERPLEXITY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (res.ok) return res;

      if (res.status === 401) {
        const t = await res.text();
        console.error('Perplexity 401 (check PERPLEXITY_API_KEY):', t.slice(0, 300));
        throw new AccessError(502, {
          error: 'Our research service is misconfigured. We are on it.'
        });
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt - 1)));
          continue;
        }
      }

      const errText = await res.text();
      console.error(`Perplexity ${res.status}:`, errText.slice(0, 500));
      throw new AccessError(502, {
        error: 'Our research service is having a moment. Try again in a minute.'
      });
    } catch (err) {
      if (err instanceof AccessError) throw err;
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 300 * attempt));
        continue;
      }
    }
  }

  console.error('Perplexity exhausted retries:', lastErr);
  throw new AccessError(502, { error: 'Connection issue. Try again?' });
}

export default async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  if (!process.env.PERPLEXITY_API_KEY) {
    console.error('PERPLEXITY_API_KEY not set');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { idToken, niche: rawNiche, count: rawCount } = body || {};

  if (!idToken) return jsonResponse(400, { error: 'Missing idToken' });

  if (typeof rawNiche !== 'string' || !rawNiche.trim()) {
    return jsonResponse(400, { error: 'Niche is required.' });
  }
  const niche = rawNiche.trim().slice(0, MAX_NICHE_LEN);

  let count = Number.isFinite(Number(rawCount)) ? Math.floor(Number(rawCount)) : DEFAULT_COUNT;
  if (count < MIN_COUNT) count = MIN_COUNT;
  if (count > MAX_COUNT) count = MAX_COUNT;

  let uid;
  try {
    uid = await verifyUser(idToken);
  } catch (err) {
    if (err instanceof AccessError) return jsonResponse(err.statusCode, err.payload);
    console.error('verifyUser error:', err);
    return jsonResponse(500, { error: 'Server error' });
  }

  let quota;
  try {
    quota = await requireProAndConsumeQuota(uid);
  } catch (err) {
    if (err instanceof AccessError) return jsonResponse(err.statusCode, err.payload);
    console.error('Quota error:', err);
    return jsonResponse(500, { error: 'Server error' });
  }

  const perplexityBody = {
    model: MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user',   content: buildUserPrompt(niche, count) }
    ],
    temperature: 0.4,
    stream: false,
    search_recency_filter: 'week',
    return_citations: true,
    return_images: false
  };

  let upstream;
  try {
    upstream = await callPerplexityWithRetry(perplexityBody, process.env.PERPLEXITY_API_KEY);
  } catch (err) {
    if (err instanceof AccessError) return jsonResponse(err.statusCode, err.payload);
    console.error('Perplexity call error:', err);
    return jsonResponse(502, {
      error: 'Our research service is having a moment. Try again in a minute.'
    });
  }

  let upstreamJson;
  try {
    upstreamJson = await upstream.json();
  } catch (err) {
    console.error('Perplexity response not JSON:', err);
    return jsonResponse(502, { error: 'Research service returned unreadable data. Try again.' });
  }

  const content = upstreamJson?.choices?.[0]?.message?.content || '';
  const inputTokens  = upstreamJson?.usage?.prompt_tokens     || 0;
  const outputTokens = upstreamJson?.usage?.completion_tokens || 0;

  const arrayText = extractJsonArray(content);
  let parsed = null;
  if (arrayText) {
    try { parsed = JSON.parse(arrayText); } catch { parsed = null; }
  }

  let topics = [];
  if (Array.isArray(parsed)) {
    topics = parsed.map(normalizeTopic).filter(Boolean);
  }

  const latencyMs = Date.now() - startedAt;
  const costEstimateUsd = estimateCost(inputTokens, outputTokens);

  if (topics.length === 0) {
    console.warn('Trending topics parse failed', JSON.stringify({
      uid,
      niche,
      count,
      contentLen: content.length,
      contentSample: content.slice(0, 500),
      parsedIsArray: Array.isArray(parsed),
      parsedLen: Array.isArray(parsed) ? parsed.length : -1
    }));
    return jsonResponse(502, {
      error: 'We could not read the research results. Try again in a moment.'
    });
  }

  console.log(JSON.stringify({
    event: 'trending_topics',
    uid,
    tier: quota.tier,
    used: quota.used,
    limit: quota.limit,
    niche,
    requested: count,
    returned: topics.length,
    latencyMs,
    inputTokens,
    outputTokens,
    costEstimateUsd,
    ok: true
  }));

  return jsonResponse(200, { topics });
};
