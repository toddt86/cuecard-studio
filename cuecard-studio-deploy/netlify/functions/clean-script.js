// netlify/functions/clean-script.js
// AI script cleaner for cuecard.studio. Pro-gated on the client.
// Uses Claude Haiku 4.5 to keep per-call cost low.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

const MODEL = 'claude-haiku-4-5';
const MAX_INPUT_CHARS = 20000; // ~5k tokens, plenty for a script
const MONTHLY_AI_LIMIT = 100;

const PROMPTS = {
  clean: `You are a script cleaner for a teleprompter app. The user will give you a script that may contain production junk. Your job:

1. REMOVE all of the following:
   - Voiceover labels (VO:, V.O., VOICEOVER:, NARRATOR:, HOST:, speaker names followed by a colon)
   - Square-bracket directions ([SFX], [CUT TO], [MUSIC], [PAUSE], [B-ROLL], etc.)
   - Parenthetical stage directions like (beat), (smiling), (to camera)
   - Timestamps (00:15, 1:30, [00:00:15], etc.)
   - Scene headings (INT., EXT., SCENE 1, etc.)
   - Any line that is purely a production note

2. FLATTEN the result into ONE continuous paragraph. Remove all line breaks. Join everything with single spaces.

3. Do NOT change the actual spoken words in any way. Do not rephrase, summarize, or correct grammar. Preserve the exact wording the talent will read.

Output ONLY the cleaned script as a single paragraph. No preamble, no explanation, no markdown, no quotes around it.`,

  paragraphs: `You are formatting a teleprompter script for readability. The user will give you a script that is one long block of text. Your job:

1. Add logical paragraph breaks where the topic, beat, or thought shifts.
2. Use a blank line (two newlines) between paragraphs.
3. Aim for paragraphs of roughly 2 to 5 sentences, but follow the natural rhythm of the script, not a rigid count.
4. Do NOT change any words. Do not add, remove, rephrase, or correct anything. Do not fix grammar or punctuation.

Output ONLY the reformatted script. No preamble, no explanation, no markdown.`,

  split: `You are analyzing a teleprompter script file that may contain MULTIPLE separate scripts pasted together (for example, three different 30-second ad variations, or a batch of social media scripts). Your job:

1. Detect whether there are multiple distinct scripts. Signals include: repeated hooks or openings, numbered labels (Script 1, Version A, Option 2), clear topic changes, or repeated call-to-action endings.
2. If there are multiple scripts, label each one with this exact marker on its own line, with a blank line above and below it:

[Script {n}]

   Where {n} is the script number starting at 1. Put the marker ABOVE each script (including the first one). Example output format:

[Script 1]

First script content here.

[Script 2]

Second script content here.

3. If there is only ONE script, return it unchanged with no marker added. Do not guess or force a split.
4. Do NOT change any of the actual script wording. Preserve every word exactly.

Output ONLY the result. No preamble, no explanation, no markdown fences.`,

  smartChunk: `You are splitting a teleprompter script into cue cards for on-camera talent. The user will give you a cleaned script. Your job:

1. Split the script into cue cards. Put ONE card per line. Separate cards with a single newline.
2. Each card must be between 6 and 18 words. Never exceed 18 words on a single card. Prefer 10 to 16 words when possible.
3. Prefer breaks at the strongest natural boundaries, in this order:
   a. End of a sentence (. ! ?)
   b. End of an independent clause (; or a hard comma pause)
   c. Before a conjunction (and, but, so, because, which) if a sentence would otherwise exceed 18 words
4. NEVER split in the middle of a proper noun, product name, idiom, or tight phrase. Keep short sentences intact even if they are under 6 words, rather than force a merge.
5. Do NOT change any word. No rephrasing, no edits, no added punctuation. Preserve every word exactly.
6. Do NOT number the cards or add labels. Just the lines of script, one card per line, no blank lines between them.

Output ONLY the resulting lines. No preamble, no explanation, no markdown.`,

  lineByLine: `You are formatting a teleprompter script so each sentence sits on its own line. The user will give you a script. Your job:

1. Put every sentence on its own line. Separate sentences with a SINGLE newline (one line break), not a blank line between them.
2. Treat each complete sentence (ending in . ! or ?) as its own line.
3. Do NOT add blank lines between sentences. No double spacing.
4. Do NOT change any words. Do not add, remove, rephrase, correct grammar, or fix punctuation.

Output ONLY the reformatted script. No preamble, no explanation, no markdown, no quotes.`,

  punctuation: `You are fixing punctuation in a teleprompter script. The user will give you a script that may be missing punctuation marks (common with voice-transcribed or rough-draft text). Your job:

1. Add missing periods at the end of sentences.
2. Add missing commas where they are clearly needed for natural reading pauses.
3. Add missing question marks where a sentence is clearly a question.
4. Add missing exclamation points only where clearly warranted by context.
5. Add missing semicolons or colons only when clearly needed.

STRICT RULES:
- Do NOT change, add, remove, reorder, or rephrase any words. Not a single word.
- Do NOT change capitalization of any letter.
- Do NOT add apostrophes or fix contractions (leave "dont" as "dont", "its" as "its").
- Do NOT fix grammar, spelling, or typos.
- Punctuation marks only: . , ? ! ; :

Output ONLY the corrected script. No preamble, no explanation, no markdown.`
};

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { idToken, action, script } = JSON.parse(event.body || '{}');

    if (!idToken || !action || !script) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing idToken, action, or script' }) };
    }

    if (!PROMPTS[action]) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
    }

    if (script.length > MAX_INPUT_CHARS) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Script too long. Max ' + MAX_INPUT_CHARS + ' characters.' }) };
    }

    // Verify Firebase auth and pro status server-side
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid auth token' }) };
    }

    const uid = decoded.uid;
    const prefsSnap = await admin.firestore().doc('users/' + uid + '/settings/prefs').get();
    const prefs = prefsSnap.exists ? prefsSnap.data() : {};
    if (!prefs.pro) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Pro subscription required' }) };
    }

    // Check and enforce monthly AI usage cap
    const db = admin.firestore();
    const usageRef = db.doc('users/' + uid + '/settings/aiUsage');
    const usageSnap = await usageRef.get();
    const usage = usageSnap.exists ? usageSnap.data() : {};
    const now = new Date();
    const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const count = (usage.month === currentMonth) ? (usage.count || 0) : 0;

    if (count >= MONTHLY_AI_LIMIT) {
      return { statusCode: 429, body: JSON.stringify({
        error: 'Monthly AI limit reached (' + MONTHLY_AI_LIMIT + ' uses). Resets on the 1st.',
        limit: MONTHLY_AI_LIMIT,
        used: count
      }) };
    }

    // Call Claude
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: PROMPTS[action],
        messages: [{ role: 'user', content: script }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'AI service error' }) };
    }

    const data = await apiRes.json();
    const cleaned = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    if (!cleaned) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Empty response from AI' }) };
    }

    // Increment usage counter after successful call
    await usageRef.set({ month: currentMonth, count: count + 1 }, { merge: true });

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: cleaned, aiUsed: count + 1, aiLimit: MONTHLY_AI_LIMIT })
    };
  } catch (err) {
    console.error('clean-script error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};
