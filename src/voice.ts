// Voice: everything about the voice channel that is a GUESS, in one place.
//
// We don't place calls. For voice, next_message carries the script the call would say (what a
// voice agent or text-to-speech reads to the user), in `body`. The shape is the same as SMS:
//
//   { channel: "voice", send_at, subject: null, body: "<call script>",
//     cta: { type: "schedule_tour", options: ["Thu", "Fri"] } }
//
// None of this comes from sample data yet. When real voice records arrive:
//   1. Put one in data/sample.jsonl and its typed copy in test/fixtures.ts, replacing
//      `voiceWelcomeDay0Guess`.
//   2. Run `npm start` and `npm test`, then adjust the values below to match what they send:
//      the CTA style, the length cap, the opt-out line, the template wording and the prompt rules.
//   3. If they use a different field for the script (e.g. `script` instead of `body`), or add
//      fields (voicemail vs. live call), change the "voice" variant of NextMessage in types.ts.

import { weekdayName } from "./dates.ts";
import type { LifecycleStage } from "./types.ts";

// How the CTA is offered on a call: spoken/keypad reply choices like SMS ("options"), or a
// link like email ("link"; unlikely, since a link can't be read out usefully).
export const VOICE_CTA_STYLE: "options" | "link" = "options";

// Longest script, in characters. ~500 characters is about 30 seconds spoken at a normal pace.
export const VOICE_MAX_LENGTH = 500;

// The spoken opt-out line. Keeps the STOP keyword, like SMS, so the same opt-out check works
// in every language.
export const ENGLISH_VOICE_OPT_OUT = "To stop these calls, say STOP.";

// ["Thu", "Fri"] -> "Press or say 1 for Thursday, 2 for Friday."
// Full weekday names: the script is read aloud, so no abbreviations.
export function englishSpokenReplyLine(options: string[]): string {
  return `Press or say ${options.map((o, i) => `${i + 1} for ${weekdayName(o, "en")}`).join(", ")}.`;
}

// The English template script (the fallback when the model is unavailable, and what the tests
// use). `when` is the tour-week phrase, e.g. "this week".
//   "Hi Taylor, this is Oak Ridge calling to welcome you! Tours are available this week. Would
//    you like to book a time on Thursday or Friday? Press or say 1 for Thursday, 2 for Friday."
export function englishVoiceScript(input: {
  lifecycle_stage: LifecycleStage;
  first_name: string;
  short_property_name: string;
  when: string;
  options: string[];
}): string {
  const { first_name, short_property_name: name, options } = input;
  const opener =
    input.lifecycle_stage === "new"
      ? `Hi ${first_name}, this is ${name} calling to welcome you!`
      : `Hi ${first_name}, this is ${name} calling to check in.`;
  const days = options.map((o) => weekdayName(o, "en")).join(" or ");
  return `${opener} Tours are available ${input.when}. Would you like to book a time on ${days}? ${englishSpokenReplyLine(options)}`;
}

// The voice section of the language model's system prompt (llm.ts).
export const VOICE_PROMPT_RULES = `Voice (channel "voice"):
- This is the script a voice agent reads aloud on a phone call, so write it to be spoken: full words, no abbreviations, no symbols (no "—", "→", "&", "/"), no links, no emojis.
- subject is null.
- At most ${VOICE_MAX_LENGTH} characters including the opt-out (about 30 seconds spoken).
- Body starts with the everyday greeting and first_name, then says who is calling (property_name). English: "Hi <first_name>, this is <property_name> calling ...".
- new lead: call to welcome them, in a form that doesn't depend on the reader's gender; open lead: call to check in.
- Say tours are available in the tour_week window, ask whether they'd like to book a time on the tour_days (full weekday names), then give numbered choices they can press or say, in tour_days order. English reference: "Hi Taylor, this is Oak Ridge calling to welcome you! Tours are available this week. Would you like to book a time on Thursday or Friday? Press or say 1 for Thursday, 2 for Friday."
- Opt-out (if required), English reference: "${ENGLISH_VOICE_OPT_OUT}"; in other languages, translate it but keep the keyword STOP.`;
