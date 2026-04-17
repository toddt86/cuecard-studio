// netlify/functions/fact-check.mjs
// Feature 3: Fact Check.
//
// POST endpoint that verifies the user, consumes a daily quota slot, and
// calls Perplexity `sonar` to identify factual claims in a script and
// verify each one against current web sources. Returns a JSON array:
//
//   { claim, status, reason, sources[] }
//
// status is one of: "verified" | "questionable" | "contradicted"
//
// The `claim` field must be a verbatim substring of the input script so the
// client can locate it and highlight it in place. We enforce this server-side
// by rejecting any claim we can't find in the script (case-insensitive).
//
// No streaming — we validate JSON before sending downstream. sonar is fast
// enough that streaming isn't worth the complexity.
//
// Telemetry: logs uid, scriptLen, claimCount, status breakdown, latency,
// tokens, cost. Never the script content or the claims themselves.

import {
  verifyUser,
  requireProAndConsumeQuota,
  AccessError
} from './_shared/access-lite.mjs';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';
const MIN_SCRIPT_LEN = 30;
const MAX_SCRIPT_LEN = 6000;
const MAX_CLAIMS = 15;
const VALID_STATUSES = new Set(['verified', 'questionable', 'contradicted']);

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
  return `You are a fact-checker for short-form video scripts. You identify specific factual claims and verify each one using current web search. You return strict JSON.

A factual claim is a specific, verifiable statement about the world: a number, a date, a named event, a company action, a scientific finding, a quoted statistic, an attribution, a proper noun doing something. Opinions, subjective framing, calls to action, hypotheticals, rhetorical questions, and generic truisms ("AI is changing everything", "focus is your superpower") are NOT claims. Skip them.

For each claim return an object with this EXACT shape:
{
  "claim": "a verbatim substring copied character-for-character from the script — the client will search the script for this exact string to highlight it, so apostrophe style, casing, punctuation, and wording must match the script EXACTLY",
  "status": "verified" | "questionable" | "contradicted",
  "reason": "one sentence explaining your verdict, naming the source generically ('according to Reuters and AP') rather than using brackets like [1]",
  "sources": ["https://...", "https://..."]
}

Status definitions:
- "verified": current credible sources confirm the claim as stated in the script.
- "questionable": the claim is partly right, outdated, missing important context, or only weakly sourced.
- "contradicted": credible current sources directly contradict the claim.

Rules:
- Output ONLY a JSON array. No markdown. No code fences. No preamble. No closing remarks.
- Start with [ and end with ].
- Each claim has 1 to 3 source URLs. Every URL must be real and reachable.
- "claim" MUST be a verbatim substring of the input script. Do not paraphrase. Do not clean up. Copy it character-for-character including punctuation.
- Find at most ${MAX_CLAIMS} claims. Return the most important ones. Do not pad.
- If the script has no factual claims, return [].
- Do not fact-check the same claim twice.
- Do not include brackets like [1] or [citation] in the reason field.`;
}

function buildUserPrompt(script) {
  return `Fact-check this short-form video script. Identify each specific factual claim, verify it with current web search, and return a JSON array.

SCRIPT (between the triple quotes):
"""
${script}
"""

Return a JSON array as specified. Start with [ and end with ]. No other text.`;
}

// Strip code fences and grab the first [ ... last ] block.
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

// Find the claim's offset range in the script. Try exact, then
// case-insensitive. If the model added or dropped quotes/spacing we bail —
// better to drop one claim than to highlight the wrong span.
function findClaimSpan(script, claim) {
  if (!claim) return null;
  let idx = script.indexOf(claim);
  if (idx !== -1) return { start: idx, end: idx + claim.length };
  const scriptLower = script.toLowerCase();
  const claimLower = claim.toLowerCase();
  idx = scriptLower.indexOf(claimLower);
  if (idx !== -1) return { start: idx, end: idx + claim.length };
  return null;
}

// Validate and normalize a single claim. Returns the sanitized claim with
// resolved offsets, or null if we should drop it.
function normalizeClaim(raw, script) {
  if (!raw || typeof raw !== 'object') return null;
  const rawClaim = typeof raw.claim === 'string' ? raw.claim.trim() : '';
  const reason   = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  const status   = typeof raw.status === 'string' ? raw.status.toLowerCase().trim() : '';
  if (!rawClaim || !reason) return null;
  if (!VALID_STATUSES.has(status)) return null;

  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter(u => typeof u === 'string' && isValidHttpUrl(u))
    : [];
  if (sources.length === 0) return null;

  const span = findClaimSpan(script, rawClaim);
  if (!span) return null;

  // Use the EXACT substring from the script so casing/punctuation matches
  // what the user sees. Also strip any brackets like [1] from the reason.
  const cleanReason = reason
    .replace(/\[\d+\](?:\[\d+\])*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    claim: script.slice(span.start, span.end),
    status,
    reason: cleanReason.slice(0, 400),
    sources: sources.slice(0, 3),
    start: span.start,
    end: span.end
  };
}

// Sort claims by start ascending. If any later claim overlaps an earlier
// one, drop the later one — highlights must be non-overlapping.
function dedupeOverlapping(claims) {
  const sorted = [...claims].sort((a, b) => a.start - b.start);
  const out = [];
  let lastEnd = -1;
  for (const c of sorted) {
    if (c.start >= lastEnd) {
      out.push(c);
      lastEnd = c.end;
    }
  }
  return out;
}

// Same retry policy as generate-script / trending-topics: exponential
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

  const { idToken, script: rawScript } = body || {};

  if (!idToken) return jsonResponse(400, { error: 'Missing idToken' });

  if (typeof rawScript !== 'string' || !rawScript.trim()) {
    return jsonResponse(400, { error: 'Script is required.' });
  }
  const script = rawScript.trim();
  if (script.length < MIN_SCRIPT_LEN) {
    return jsonResponse(400, { error: 'Script is too short to fact-check. Add at least a couple of sentences.' });
  }
  if (script.length > MAX_SCRIPT_LEN) {
    return jsonResponse(400, { error: `Script is too long. Trim it under ${MAX_SCRIPT_LEN} characters.` });
  }

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
      { role: 'user',   content: buildUserPrompt(script) }
    ],
    temperature: 0.2,
    stream: false,
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

  let claims = [];
  if (Array.isArray(parsed)) {
    claims = parsed.map(c => normalizeClaim(c, script)).filter(Boolean);
    claims = dedupeOverlapping(claims);
  }

  const latencyMs = Date.now() - startedAt;
  const costEstimateUsd = estimateCost(inputTokens, outputTokens);

  // An empty `parsed` array is a valid outcome (no factual claims in the
  // script). We only treat it as a parse failure if the model returned
  // content but we couldn't extract any structure at all.
  if (!Array.isArray(parsed)) {
    console.warn('Fact check parse failed', JSON.stringify({
      uid,
      scriptLen: script.length,
      contentLen: content.length,
      contentSample: content.slice(0, 500)
    }));
    return jsonResponse(502, {
      error: 'We could not read the fact-check results. Try again in a moment.'
    });
  }

  const verified      = claims.filter(c => c.status === 'verified').length;
  const questionable  = claims.filter(c => c.status === 'questionable').length;
  const contradicted  = claims.filter(c => c.status === 'contradicted').length;

  console.log(JSON.stringify({
    event: 'fact_check',
    uid,
    tier: quota.tier,
    used: quota.used,
    limit: quota.limit,
    scriptLen: script.length,
    rawClaims: Array.isArray(parsed) ? parsed.length : 0,
    returned: claims.length,
    verified,
    questionable,
    contradicted,
    latencyMs,
    inputTokens,
    outputTokens,
    costEstimateUsd,
    ok: true
  }));

  // Strip start/end from payload — internal only, client doesn't need them
  // (we'll recompute client-side against the script text we sent).
  const clientClaims = claims.map(c => ({
    claim: c.claim,
    status: c.status,
    reason: c.reason,
    sources: c.sources
  }));

  return jsonResponse(200, { claims: clientClaims });
};
