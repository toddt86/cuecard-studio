# Cue Card Studio AI Features Spec

Three paid features behind the existing Stripe subscription gate.

## Feature 1: Script from URL

### Inputs
- `url`: string, validated as URL before submission
- `duration`: one of `30`, `60`, `90`, `120` (seconds)
- `tone`: one of `conversational`, `authoritative`, `energetic`, `documentary`

### Behavior
1. Validate subscription (see gating).
2. Validate daily rate limit (see gating).
3. Call Perplexity `sonar-pro` with the Writing Framework system 
   prompt plus the URL-reading instruction.
4. Stream response tokens back to the client.
5. On stream completion, return citations array.

### Output
- Script text streamed into the teleprompter editor.
- Citations list rendered in a sidebar or modal.
- Word count displayed, with a warning if outside target range.

### UI states
- Idle: form with URL input, duration picker, tone picker, generate button.
- Loading: streaming tokens into the editor, with a "Stop" button.
- Complete: script in editor, citations in sidebar, option to regenerate 
  or tweak parameters.
- Error: inline message with retry button.

## Feature 2: Trending Topics

### Inputs
- `niche`: string (free-form or from preset categories)
- `count`: default 5, max 10

### Behavior
1. Validate subscription and rate limit.
2. Call Perplexity `sonar` with `search_recency_filter: 'week'`.
3. Parse returned JSON (5 trending items).
4. Render as clickable cards.
5. Clicking a card pre-fills the Script from URL feature with that 
   story's angle.

### Output shape
```json
[
  {
    "headline": "short hook-style title",
    "why_now": "one sentence on why trending this week",
    "angle": "narrative angle to take",
    "source_urls": ["url1", "url2"]
  }
]
```

## Feature 3: Fact Check

### Inputs
- `script`: the user's current teleprompter text

### Behavior
1. Validate subscription and rate limit.
2. Call Perplexity `sonar-pro` with fact-check system prompt.
3. Parse returned JSON of claims with statuses.
4. Render highlighted script with colored markers (green verified, 
   yellow needs source, red disputed).

### Output shape
```json
[
  {
    "claim": "exact substring from script",
    "status": "verified|disputed|needs_source",
    "correction": "only if disputed",
    "sources": ["url"]
  }
]
```

## Gating

### Subscription check
User must have `status: active` in the subscription store. Free users 
get a paywall modal that deep-links to the upgrade page.

### Daily rate limits
- Monthly ($6.99): 30 generations per day, counted across all three features.
- Annual ($49.99): 100 per day.
- Lifetime ($119): 100 per day.

Reset at UTC midnight. Tracked in Netlify Blobs or Supabase keyed by 
`usage:{userId}:{YYYY-MM-DD}`.

### When a limit is hit
- Return HTTP 429 from the function.
- UI shows a toast: "You've hit today's generation limit. Resets at 
  midnight UTC."
- No upsell modal on rate limit (user is already paying).

## Error UX

- Network error: "Connection issue. Try again?" with retry button.
- Perplexity down: "Our research service is having a moment. Try 
  again in a minute."
- Invalid URL: client-side validation before submit.
- URL that Perplexity cannot read: "We couldn't read that page. 
  Try a different URL or paste the content directly."

## Telemetry

Log every generation call with:
- userId, feature name, tone, duration, success/fail, latency, 
  tokens used, cost estimate

Never log the script content itself. Never log the URL the user 
submitted. Privacy matters here because creators often work on 
unreleased content.
