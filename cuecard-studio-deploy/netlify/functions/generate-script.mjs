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

// Server-side article fetch config. We fetch the source URL ourselves and
// pass the text directly into the prompt, instead of trusting Perplexity to
// read the URL reliably. Why: sonar-pro's URL reading is inconsistent — it
// sometimes blends training data into specifics, which yields scripts that
// sound confident but contain fabricated facts. Feeding the article content
// directly collapses that failure mode.
const ARTICLE_FETCH_TIMEOUT_MS = 8000;
const ARTICLE_FETCH_MAX_BYTES  = 5 * 1024 * 1024; // 5 MB ceiling on raw HTML
const ARTICLE_TEXT_MAX_CHARS   = 15000;           // matches MAX_ARTICLE_TEXT_LEN in writing-framework
const ARTICLE_TEXT_MIN_CHARS   = 400;             // below this, treat as failure and fall back to URL-only
const ARTICLE_UA = 'Mozilla/5.0 (compatible; cuecard-studio/1.0; +https://cuecard.studio)';

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

// Extract human-readable article text from raw HTML. Zero-dep on purpose:
// pulling in a DOM parser (jsdom, linkedom, cheerio) would triple the
// function cold-start time for a task we can do well-enough with regex.
//
// Strategy:
// 1. Strip <script>, <style>, <noscript>, <template>, <svg>, <header>,
//    <footer>, <nav>, <aside>, <form> blocks wholesale — they carry no
//    article content and a lot of boilerplate.
// 2. If there's an <article> or <main> tag, prefer that chunk.
// 3. Strip remaining tags. Decode a small set of common HTML entities.
// 4. Collapse whitespace and trim.
//
// This gets us readable text for 95%+ of news articles without a DOM.
function extractArticleText(html) {
  if (!html || typeof html !== 'string') return '';

  // Normalize carriage returns first to keep regexes predictable.
  let s = html.replace(/\r\n?/g, '\n');

  // Block-level removal of things that never carry article text.
  const blockTags = ['script', 'style', 'noscript', 'template', 'svg', 'header', 'footer', 'nav', 'aside', 'form'];
  for (const tag of blockTags) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    s = s.replace(re, ' ');
  }

  // Prefer <article> or <main> content if present. If multiple <article>
  // tags exist we concatenate them — some outlets split a page into
  // sections. If neither tag exists, fall back to the <body>.
  let candidates = [];
  const articleRe = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = articleRe.exec(s))) candidates.push(m[1]);

  if (candidates.length === 0) {
    const mainRe = /<main\b[^>]*>([\s\S]*?)<\/main>/gi;
    while ((m = mainRe.exec(s))) candidates.push(m[1]);
  }

  if (candidates.length === 0) {
    const bodyMatch = s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) candidates.push(bodyMatch[1]);
    else candidates.push(s);
  }

  let chunk = candidates.join('\n\n');

  // Convert block-ending tags to newlines so paragraph structure survives.
  chunk = chunk
    .replace(/<\/(p|h[1-6]|div|section|li|blockquote|br)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  // Strip all remaining tags.
  chunk = chunk.replace(/<[^>]+>/g, ' ');

  // Decode a small set of common entities. Full entity decoding is a
  // rabbit hole; these cover 99% of what shows up in article copy.
  chunk = chunk
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) && code > 0 && code < 0x10FFFF ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10FFFF ? String.fromCodePoint(code) : '';
    });

  // Collapse whitespace.
  chunk = chunk
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return chunk.slice(0, ARTICLE_TEXT_MAX_CHARS);
}

// Fetch the article URL with a short timeout and a size cap. Returns the
// extracted article text (empty string on failure). Never throws — all
// failures are logged and the caller falls back to URL-only mode.
async function fetchArticleText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': ARTICLE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!res.ok) {
      console.warn(`Article fetch non-OK: ${res.status} for ${new URL(url).host}`);
      return '';
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('text/html') && !ct.includes('application/xhtml')) {
      console.warn(`Article fetch skipped non-HTML content-type: ${ct}`);
      return '';
    }

    // Read with a size cap so a pathological response can't OOM the function.
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > ARTICLE_FETCH_MAX_BYTES) {
        console.warn(`Article fetch exceeded size cap at ${received} bytes`);
        try { reader.cancel(); } catch {}
        break;
      }
      chunks.push(value);
    }

    const buf = new Uint8Array(received > ARTICLE_FETCH_MAX_BYTES ? ARTICLE_FETCH_MAX_BYTES : received);
    let offset = 0;
    for (const c of chunks) {
      if (offset + c.byteLength > buf.byteLength) {
        buf.set(c.subarray(0, buf.byteLength - offset), offset);
        break;
      }
      buf.set(c, offset);
      offset += c.byteLength;
    }

    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const text = extractArticleText(html);
    return text;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.warn(`Article fetch timed out after ${ARTICLE_FETCH_TIMEOUT_MS}ms`);
    } else {
      console.warn('Article fetch failed:', err && err.message ? err.message : err);
    }
    return '';
  } finally {
    clearTimeout(timer);
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

  // Pre-fetch the article text server-side. If it succeeds, we feed the
  // content directly to the model so it writes from the actual source
  // instead of guessing at or hallucinating the article. If it fails
  // (paywall, block, timeout), we fall back to URL-only mode — the prompt
  // picks that up and shifts the model into "stay generic" posture.
  const articleFetchStart = Date.now();
  const articleText = await fetchArticleText(url);
  const articleFetchMs = Date.now() - articleFetchStart;
  const articleUsed = articleText.length >= 400; // matches ARTICLE_TEXT_MIN_CHARS

  const { systemPrompt, userPrompt, wordTarget, articleTextLen } = buildScriptPrompt({
    url,
    duration: durationNum,
    tone,
    articleText: articleUsed ? articleText : ''
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

          // SSE events are separated by a blank line. Perplexity uses CRLF
          // line endings (\r\n\r\n between events), so splitting on bare
          // '\n\n' misses every boundary and no tokens flow through. Match
          // both CRLF and LF forms.
          const events = buffer.split(/\r?\n\r?\n/);
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
        articleFetchMs,
        articleUsed,
        articleTextLen,
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
