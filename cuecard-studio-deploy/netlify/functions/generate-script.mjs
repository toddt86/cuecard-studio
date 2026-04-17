// netlify/functions/generate-script.mjs
// Feature 1: Script from URL.
//
// POST endpoint that verifies the user is signed in and on an active paid
// tier, enforces their daily cross-feature quota, then calls Perplexity
// sonar-pro with streaming enabled. We re-emit the upstream SSE in our own
// compact format so the client only has to parse two event shapes:
//
//   data: {"type":"token","content":"..."}
//   data: {"type":"citations","citations":["url",...]}
//   data: [DONE]
//
// Telemetry: we log userId + metadata + latency + cost estimate.
// Never the URL the user submitted. Never a single character of the script.

import {
  verifyUser,
  requireProAndConsumeQuota,
  AccessError
} from './_shared/access-lite.mjs';
import { buildScriptPrompt } from './_shared/writing-framework.js';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar-pro';
const VALID_DURATIONS = [30, 60, 90, 120];
const VALID_TONES = ['conversational', 'authoritative', 'energetic', 'documentary'];

// sonar-pro pricing: $3 per M input tokens, $15 per M output tokens.
function estimateCost(inputTokens, outputTokens) {
  const inCost = (inputTokens / 1_000_000) * 3;
  const outCost = (outputTokens / 1_000_000) * 15;
  return +(inCost + outCost).toFixed(5);
}

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function jsonError(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// Call Perplexity. Retry on 429 / 5xx / network errors with exponential
// backoff. Never retry on 401 (bad key, fail closed).
async function callPerplexityWithRetry(body, apiKey) {
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(PERPLEXITY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
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
          const delay = 300 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
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
    return jsonError(405, { error: 'Method not allowed' });
  }

  if (!process.env.PERPLEXITY_API_KEY) {
    console.error('PERPLEXITY_API_KEY not set in environment');
    return jsonError(500, { error: 'Server misconfigured' });
  }

  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, { error: 'Invalid JSON body' });
  }

  const { idToken, url, duration, tone } = body || {};

  if (!idToken) return jsonError(400, { error: 'Missing idToken' });
  if (!url || typeof url !== 'string' || !isValidHttpUrl(url)) {
    return jsonError(400, { error: 'Invalid URL' });
  }
  const durationNum = Number(duration);
  if (!VALID_DURATIONS.includes(durationNum)) {
    return jsonError(400, { error: 'Invalid duration' });
  }
  if (!VALID_TONES.includes(tone)) {
    return jsonError(400, { error: 'Invalid tone' });
  }

  let uid;
  try {
    uid = await verifyUser(idToken);
  } catch (err) {
    if (err instanceof AccessError) return jsonError(err.statusCode, err.payload);
    console.error('verifyUser error:', err);
    return jsonError(500, { error: 'Server error' });
  }

  let quota;
  try {
    quota = await requireProAndConsumeQuota(uid);
  } catch (err) {
    if (err instanceof AccessError) return jsonError(err.statusCode, err.payload);
    console.error('Quota error:', err);
    return jsonError(500, { error: 'Server error' });
  }

  const { systemPrompt, userPrompt, wordTarget } = buildScriptPrompt({
    url,
    duration: durationNum,
    tone
  });

  const perplexityBody = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.6,
    stream: true,
    return_citations: true,
    return_images: false
  };

  let upstream;
  try {
    upstream = await callPerplexityWithRetry(perplexityBody, process.env.PERPLEXITY_API_KEY);
  } catch (err) {
    if (err instanceof AccessError) return jsonError(err.statusCode, err.payload);
    console.error('Perplexity call error:', err);
    return jsonError(502, {
      error: 'Our research service is having a moment. Try again in a minute.'
    });
  }

  // Build a downstream stream that re-emits upstream SSE in our compact format,
  // and logs telemetry once complete.
  const encoder = new TextEncoder();
  let outputChars = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let citations = null;
  let streamError = null;

  // Captured so we can log a safe sample if we never parsed any tokens from
  // the upstream response. Helps diagnose format mismatches without exposing
  // any user-generated content (there is none when outputChars stays 0).
  let rawSample = '';

  const downstream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;
          if (rawSample.length < 1500) {
            rawSample = (rawSample + decoded).slice(0, 1500);
          }

          // SSE events are separated by a blank line.
          const events = buffer.split('\n\n');
          buffer = events.pop();

          for (const rawEvent of events) {
            const lines = rawEvent.split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') continue;

              let chunk;
              try { chunk = JSON.parse(payload); } catch { continue; }

              if (Array.isArray(chunk.citations)) {
                citations = chunk.citations;
              }
              if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens || inputTokens;
                outputTokens = chunk.usage.completion_tokens || outputTokens;
              }

              const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
              const content = delta && delta.content;
              if (content) {
                outputChars += content.length;
                controller.enqueue(encoder.encode(sseEvent({ type: 'token', content })));
              }
            }
          }
        }
      } catch (err) {
        streamError = err;
        console.error('Stream pipe error:', err);
      } finally {
        try { reader.releaseLock(); } catch {}
      }

      try {
        if (citations) {
          controller.enqueue(encoder.encode(sseEvent({ type: 'citations', citations })));
        }
        if (streamError) {
          controller.enqueue(encoder.encode(sseEvent({
            type: 'error',
            error: 'Stream interrupted. Please regenerate.'
          })));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch {}

      // Diagnostic: if we reached end-of-stream with no content at all,
      // log what Perplexity actually sent so we can see the format. Safe
      // because there was no user content to leak — outputChars is 0.
      if (outputChars === 0) {
        console.warn('generate-script empty response diagnostic:', JSON.stringify({
          upstreamStatus: upstream.status,
          upstreamContentType: upstream.headers.get('content-type'),
          rawSampleLen: rawSample.length,
          rawSample: rawSample.slice(0, 1200),
          trailingBuffer: buffer.slice(0, 300)
        }));
      }

      // Telemetry. Intentionally omits `url` and any script content.
      const latencyMs = Date.now() - startedAt;
      const costEstimateUsd = estimateCost(inputTokens, outputTokens);
      console.log(JSON.stringify({
        event: 'generate_script',
        uid,
        tier: quota.tier,
        used: quota.used,
        limit: quota.limit,
        duration: durationNum,
        tone,
        wordTarget: wordTarget.target,
        latencyMs,
        inputTokens,
        outputTokens,
        outputChars,
        citationCount: citations ? citations.length : 0,
        costEstimateUsd,
        ok: !streamError
      }));
    },

    cancel() {
      // Client closed the connection (Stop button). No work to refund.
    }
  });

  return new Response(downstream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
};
