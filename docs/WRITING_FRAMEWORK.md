# Cue Card Studio Script Writing Framework

This framework governs how AI-generated scripts sound. Every script 
generation call must follow these rules. The goal is scripts that read 
naturally aloud on a teleprompter, not text that reads well on a page.

## Core principle

A teleprompter script is spoken language captured in text. It is not 
an article, a blog post, or a summary. If you can picture someone 
saying it out loud at a camera without sounding like a robot or a 
press release, it is working. If not, rewrite.

## The Dopamine Ladder (adapted for short-form spoken delivery)

Every script moves the viewer through these stages in order. For 
scripts under 60 seconds, compress the middle stages. For 90+ second 
scripts, expand them.

1. **Stimulation** (first 3 seconds): A pattern interrupt. A number, 
   a claim, a question, a contradiction. Something that makes the 
   viewer not scroll.

2. **Captivation** (next 5 to 10 seconds): Context that earns the 
   next 30 seconds of attention. Why this matters, why now, why them.

3. **Anticipation** (middle section): Set up a payoff. Tease what 
   they are about to learn, see, or feel.

4. **Validation** (proof section): Deliver facts, citations, 
   examples. This is where Perplexity's web grounding carries weight.

5. **Affection** (emotional beat): One moment that makes them feel 
   something. Humor, surprise, relief, outrage, whatever fits the 
   tone. Short.

6. **Revelation** (final line): The takeaway. Memorable, shareable, 
   quotable. The sentence they might repeat to a friend.

## Hard rules for spoken delivery

- **No em dashes.** Ever. Use commas, periods, or parentheses.
- **Short sentences.** Aim for under 15 words per sentence. If a 
  sentence cannot be said in one breath, split it.
- **Contractions always.** "You are" becomes "you're." "Do not" 
  becomes "don't." Spoken English uses contractions.
- **No list words aloud.** Never write "Firstly, Secondly, Thirdly." 
  Use "First... Then... And finally..." instead.
- **No corporate filler.** Cut "Furthermore," "Moreover," "In 
  conclusion," "It is important to note." These do not exist in 
  real speech.
- **No semicolons.** Speakers do not say semicolons. Use periods.
- **Numbers: spell out one through nine, digits for 10 and up**, 
  unless speaking a number out loud changes the cadence.
- **Read-aloud test.** Every sentence must pass the "would a human 
  actually say this?" test.

## Pacing markers

- Use a single forward slash `/` to mark a natural pause (like a 
  comma but longer). Teleprompter users scan for these.
- Use a line break for a stronger beat or emphasis shift.
- Never use ellipses `...` in final output. They are ambiguous to 
  read aloud.

## Word count targets by duration

Assume 150 words per minute as the baseline conversational pace. 
Energetic tones go slightly faster, documentary tones slightly slower.

| Duration | Target words | Range       |
|----------|--------------|-------------|
| 30 sec   | 75           | 65 to 85    |
| 60 sec   | 150          | 135 to 165  |
| 90 sec   | 225          | 210 to 240  |
| 2 min    | 300          | 280 to 320  |

Hit the target within the range. Over-shooting makes the creator 
talk fast and sound stressed.

## Tone profiles

Each tone changes word choice and sentence rhythm, not structure.

**Conversational**: Like talking to a friend. Casual vocabulary. 
Rhetorical questions. Occasional one-word sentences. "Here's the 
thing." "Wild, right?"

**Authoritative**: Measured confidence. No slang. Declarative 
sentences. Data-forward. "The evidence shows." "Three things 
matter here."

**Energetic**: Punchy. Short bursts. Exclamation points used 
sparingly but intentionally. "This changes everything." Never 
corny. Never hype-y.

**Documentary**: Observational. Slightly detached. Longer pauses. 
More description. "In 2019, something strange began happening."

## Citation handling

When the source API (Perplexity) returns citations, the script 
itself should weave in source attribution naturally for any claim 
that needs it. Example: "According to a Reuters report this week..." 
not "[1] [2]".

The full list of source URLs is returned separately in the response 
metadata and rendered in a sidebar, not in the script body.

## Hook patterns that work

For the opening 3-second Stimulation beat, these patterns convert:

- **The contradiction**: "Everyone thinks X. They're wrong."
- **The specific number**: "73 percent of X do Y. Here's why."
- **The question they cannot answer**: "Why does X do Y when Z?"
- **The admission**: "I was wrong about X."
- **The scene**: "It's 2am. Someone just..."
- **The claim with stakes**: "If you X, you're losing Y."

Rotate patterns. Do not default to the same hook every time.

## Output format

The model must output ONLY the script text. No headings. No 
preamble. No "Here's your script:". No explanation. No word count 
confirmation. Just the script, ready to paste into a teleprompter.

Pause markers (forward slashes) and line breaks are allowed. Nothing 
else is.
