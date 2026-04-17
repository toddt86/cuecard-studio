# Perplexity API Integration Reference

## Endpoint

`POST https://api.perplexity.ai/chat/completions`

OpenAI-compatible shape. Use the official OpenAI SDK with a custom 
`baseURL` if preferred, or plain `fetch`.

## Authentication

Bearer token in the Authorization header. Key lives in 
`PERPLEXITY_API_KEY` as a Netlify environment variable. Never 
exposed to the client.

## Models we use

- **sonar-pro**: Primary. Deeper research, 200K context, roughly 
  double the citations of base Sonar. Use for Script from URL and 
  Fact Check.
- **sonar**: Cheaper, faster. Use for Trending Topics where we just 
  need a quick current-events sweep.

Pricing (as of this writing): Sonar Pro is $3 per million input 
tokens, $15 per million output tokens. Sonar is $1/$1. Search 
context is billed separately per request depending on size.

## Core request shape

```javascript
{
  model: 'sonar-pro',
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ],
  temperature: 0.6,
  stream: true,
  search_recency_filter: 'week',  // optional: 'hour'|'day'|'week'|'month'
  search_domain_filter: [],       // optional: array of domains to restrict to
  return_citations: true,
  return_images: false
}
```

## Streaming response format

Server-Sent Events. Each event is a line starting with `data: ` 
followed by JSON. The terminal event is `data: [DONE]`.

Each JSON chunk looks like:

```json
{
  "id": "...",
  "model": "sonar-pro",
  "choices": [{
    "index": 0,
    "delta": { "content": "token here" },
    "finish_reason": null
  }]
}
```

Citations arrive in the final chunk(s) as a top-level `citations` 
array of URLs.

## Error handling

Status codes we handle specifically:

- `401`: Invalid API key. Log and fail closed. Never retry.
- `429`: Rate limited by Perplexity. Retry with exponential backoff, 
  max 3 attempts. If still failing, return a friendly error to the 
  user.
- `500/502/503`: Perplexity is down. Retry once. If still failing, 
  return a "try again in a moment" message.
- Network errors: Retry once.

All errors get logged with enough context to debug, never with the 
API key.

## Cost controls

Every call must be preceded by a subscription check and a daily 
rate limit check. See `docs/FEATURE_SPEC.md` for limits per tier.

Estimated cost per generation:

- Script from URL (sonar-pro, ~2K in / ~500 out): ~$0.013
- Trending Topics (sonar, ~500 in / ~800 out): ~$0.002
- Fact Check (sonar-pro, ~1K in / ~1K out): ~$0.018

Budget headroom assumes monthly plan caps at roughly $3 API cost 
per subscriber per month worst case.

## Structured output (Trending Topics, Fact Check)

Perplexity supports `response_format` with JSON schema for Sonar Pro 
on Tier 3+ usage. For lower tiers, use strong prompt instructions 
demanding JSON-only output and parse defensively with a fallback that 
strips markdown fences.
