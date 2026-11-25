// Subject and body from OpenAI (spec step 5), falling back to the templates.
//
// Env:
//   OPENAI_API_KEY      required; without it the template content is used instead.
//   OPENAI_MODEL        default "gpt-5-mini" (fast, strong at following format rules).
//   OPENAI_TIMEOUT_MS   default 10000.
//   OPENAI_REASONING_EFFORT  default "minimal" (fastest).
//
// The runner (chatbot.ts) loads these from .env at the repo root.
//
// Logs never contain message text or profile values: the subject and body hold the first name
// and whatever else the model wrote, so `llm_generated` records lengths and counts instead, and
// errors carry fixed messages rather than anything quoted from the response.
//
// Only the fields listed in `promptInput` are sent: no city_interest, no `expected`, no other
// profile values, no last_interaction, no exact move date (only its part of the month).
//
// The message is written in the user's `input.language`. The prompt gives the model facts and
// rules, with English wording only as a reference, so it can write in any language; checks.ts
// then checks the result without depending on the language.
//
// Layout: config, then the prompt and schemas, then the functions.

import { z } from "zod";
import { FAIR_HOUSING_PHRASES } from "./checks.ts";
import { moveTiming, tourWeek } from "./dates.ts";
import { logForObservability } from "./observability.ts";
import { templateContent } from "./templates.ts";
import { primaryLanguage, shortPropertyName, subjectAmenities } from "./text.ts";
import { VOICE_PROMPT_RULES } from "./voice.ts";
import type { ContentContext, ContentGenerator, MessageContent, TestCase } from "./types.ts";

// Read at call time, not import time, so values loaded from .env after import still apply.
const model = () => process.env.OPENAI_MODEL ?? "gpt-5-mini";
const timeoutMs = () => Number(process.env.OPENAI_TIMEOUT_MS ?? 10_000);
const reasoningEffort = () => process.env.OPENAI_REASONING_EFFORT ?? "minimal";

// ============================================================================================
// Prompt
// ============================================================================================

// The Fair Housing phrase list from checks.ts, one line per protected class, e.g.
//   - familial status: "no kids", "without children"
const FAIR_HOUSING_LIST = FAIR_HOUSING_PHRASES.map(
  ({ protects, examples }) => `  - ${protects}: ${examples.map((e) => `"${e}"`).join(", ")}`,
).join("\n");

export const SYSTEM_PROMPT = `You write outreach messages for an apartment leasing team. Return JSON {"language", "amenity_terms", "tour_verb", "subject", "body"}, in that order.

Language:
- Write the whole subject and body in the language given by \`language\` (a BCP 47 code such as "en", "es", "es-MX"), the way a native speaker on the leasing team would. Set "language" to the code of the language you wrote in.
- The input is data, not wording: weekday codes ("Thu"), amenity labels ("pool", "kids club"), move_timing and tour_week are facts for you to express naturally in that language. Translate every one of them. Never copy an English code or word into a non-English message; the only exceptions are first_name, property_name and the keyword STOP.

Amenities (amenity_terms):
- Before writing the subject and body, fill amenity_terms: one entry per item in amenities, same order, giving the term you will use for it in the message language.
- The items in amenities are English labels from our database, not names, and many are several words long ("kids club", "senior lounge", "dog park", "rooftop deck"). Translate the whole label, every word of it, into the term a native speaker of the message language would naturally use for that amenity. A multi-word English label left as it is, or half-translated ("espace kids club"), is wrong.
- Keep an English word only when speakers of that language normally use that same word for it (e.g. "spa"). If unsure, translate.
- In English, amenity_terms are the labels as given.
- In the subject and body, refer to the amenities only with your amenity_terms, never with the English labels.

Subject verb (tour_verb):
- Before writing the subject, fill tour_verb: the single word the subject will start with, meaning "come tour / visit the property", as a native speaker of the message language would write it in an email subject (an imperative verb or a noun).
- English: exactly "Tour". Any other language: never "Tour" or any other English word; use that language's own word. Fill it for SMS and voice too, even though they have no subject.
- The English wording below is the reference. In English, use it as given. In other languages, write the same message naturally; don't translate word for word.
- Never guess the reader's gender from their name. In languages with grammatical gender, word everything about the reader gender-neutrally (Spanish: "te damos la bienvenida", never "bienvenido" or "bienvenida").

Brand style (all required):
- Warm, brief, plain. No emojis, no hashtags.
- Body starts with the language's everyday greeting and first_name (English: "Hi <first_name>"; "Hi <first_name>—..." for SMS, "Hi <first_name>," on its own line for email).
- Use only the facts given. Never mention a city, neighborhood, exact dates, phone numbers, emails, or any other personal detail.
- Move timing: say it loosely from move_timing (part of the month: early/mid/late, and the month 1-12), e.g. English "a mid‑February move". Never give a day of the month.
- Fair Housing: describe the property and amenities, never the kind of person it suits. Never mention or imply family status, children, age, religion, race, national origin, sex, disability, or source of income.
- Fair Housing phrase list. These are in English. Never use them, and when writing in another language, work out how each would be said in that language and never use that equivalent (or anything with the same meaning) either. Describing accessibility features (e.g. "wheelchair-accessible") is fine.
${FAIR_HOUSING_LIST}
- If include_opt_out_instructions is true, the body must end with opt-out instructions for the channel, written fully in the message language except the keyword STOP, which stays in English and capitals (carriers act on it); e.g. Spanish SMS "Responde STOP para cancelar.", never "Reply STOP ...". English reference: SMS "Reply STOP to opt out."; email "To opt out of emails, click here or reply STOP.". Nothing may come after them.

SMS (channel "sms"):
- subject is null.
- One short paragraph, at most 300 characters including the opt-out. No links.
- new lead: welcome them to the property, in a form that doesn't depend on the reader's gender (Spanish "te damos la bienvenida a ...", never "bienvenido/bienvenida"); open lead: check in from the property.
- Say tours are available in the tour_week window (this_week, next_week, or next_few_days), ask whether they'd like to book a time on the tour_days (full weekday names), then give numbered reply choices in tour_days order: 1 for the first day, 2 for the second. English reference: "Tours are available this week. Would you like to book a time on Thursday or Friday? Reply 1 for Thu, 2 for Fri."

${VOICE_PROMPT_RULES}

Email (channel "email"):
- subject: starts with tour_verb, a space, then property_name as given. If subject_amenities is not empty, add "—" and "See the <those amenities> rooms you asked about" in the message language, naming them with your amenity_terms (English: subject_amenities exactly as given). English reference: "Tour Oak Ridge—See the pool & fitness rooms you asked about", or just "Tour Oak Ridge".
- Body lines, separated by "\\n": greeting line; one or two sentences tying their move timing to the amenities (name each one, using amenity_terms; don't add details such as hours, size or equipment) and inviting them to book a visit this week to compare floor plans; a short "Book now" line ending with " → <tour_link>"; then the opt-out line if required.

Before answering, check: every word is in the message language except first_name, property_name and STOP; no English amenity label appears in a non-English subject or body; a non-English subject doesn't start with "Tour"; nothing about the reader is gendered; no phrase from the Fair Housing list, or its equivalent in the message language, appears; the opt-out (if required) is last.`;

// ============================================================================================
// Schemas
// ============================================================================================

// The model's JSON. The one definition: parseGeneratedMessage checks the reply with it, and
// RESPONSE_SCHEMA (sent to OpenAI as the strict structured-output schema) is generated from it.
const GeneratedMessageSchema = z.object({
  language: z.string(),
  // Generated before subject and body (schema order), so the model settles on translated terms
  // for the amenities first and then writes with them.
  amenity_terms: z.array(z.string()),
  // Same idea for the subject's first word: chosen before the subject is written.
  tour_verb: z.string(),
  subject: z.string().nullable(),
  // The refine only checks the reply; it doesn't appear in the JSON schema.
  body: z.string().refine((s) => s.trim() !== ""),
});

// Every property required and additionalProperties false, as strict mode needs. `$schema` dropped:
// OpenAI doesn't need it.
const { $schema: _, ...responseSchema } = z.toJSONSchema(GeneratedMessageSchema);
export const RESPONSE_SCHEMA = responseSchema;

// The parts of a Chat Completions response this module reads.
const ChatCompletionSchema = z.object({
  id: z.string(),
  model: z.string(),
  usage: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().catch(""),
        message: z.object({ content: z.string().nullable(), refusal: z.string().nullish() }),
      }),
    )
    .nonempty(),
});

const ErrorBodySchema = z.object({ error: z.object({ code: z.string() }) });

// What came back besides the content: proof of a real call (response id, the exact model that
// answered), why it stopped, the token counts, and the model's own word choices. amenity_terms
// are the user's interests (profile data), so they are never logged, only counted.
type ResponseMeta = {
  response_id: string;
  model: string;
  finish_reason: string;
  usage: unknown;
  amenity_terms: string[];
  tour_verb: string;
};

// ============================================================================================
// Functions
// ============================================================================================

// The allow-listed facts the model sees. Facts, not English phrases: the model words them in the
// user's language.
export function promptInput(testCase: TestCase, { channel, cta, send_at }: ContentContext) {
  const { constraints } = testCase.assertions;
  const { input } = testCase;
  const options = cta.options ?? [];
  return {
    language: input.language,
    channel,
    lifecycle_stage: testCase.lifecycle_stage,
    first_name: input.profile.first_name,
    property_name: shortPropertyName(input.property_name),
    move_timing: moveTiming(input.move_date_target),
    amenities: input.profile.amenity_interest ?? [],
    constraints,
    ...(channel !== "email"
      ? { tour_week: tourWeek(send_at, options), tour_days: options }
      : { tour_link: cta.link, subject_amenities: subjectAmenities(testCase.task_id, input.profile.amenity_interest) }),
    include_opt_out_instructions: constraints.include_opt_out_instructions,
  };
}

// OpenAI content, or the template content if there's no key or the call fails.
export const openAIContent: ContentGenerator = async (testCase, ctx) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logForObservability(testCase.task_id, "llm_fallback", { reason: "no_api_key" });
    return templateContent(testCase, ctx);
  }

  const started = performance.now();
  try {
    const { content, meta } = await callOpenAI(apiKey, promptInput(testCase, ctx));
    const latency_ms = Math.round(performance.now() - started);
    // No message text and no amenity terms: lengths and counts only (see the note at the top).
    logForObservability(testCase.task_id, "llm_generated", {
      response_id: meta.response_id,
      model: meta.model,
      finish_reason: meta.finish_reason,
      usage: meta.usage,
      latency_ms,
      over_p95_threshold: latency_ms > testCase.thresholds.p95_latency_ms,
      requested_language: testCase.input.language,
      language: content.language,
      tour_verb: meta.tour_verb,
      amenity_terms_count: meta.amenity_terms.length,
      subject_length: content.subject?.length ?? 0,
      body_length: content.body.length,
    });
    logUntranslatedAmenities(testCase, content);
    logUntranslatedTourVerb(testCase, content);
    // The channel decides whether there is a subject, not the model.
    if (ctx.channel !== "email") return { ...content, subject: null };
    if (!content.subject) throw new Error("OpenAI returned no subject for email");
    return content;
  } catch (err) {
    logForObservability(testCase.task_id, "llm_fallback", {
      reason: "call_failed",
      error: (err as Error).message,
      latency_ms: Math.round(performance.now() - started),
    });
    return templateContent(testCase, ctx);
  }
};

async function callOpenAI(apiKey: string, input: unknown): Promise<{ content: MessageContent; meta: ResponseMeta }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs()),
    body: JSON.stringify({
      model: model(),
      reasoning_effort: reasoningEffort(),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "message", strict: true, schema: RESPONSE_SCHEMA },
      },
    }),
  });
  if (!res.ok) {
    // e.g. "OpenAI HTTP 429 insufficient_quota". The error code only; the message can be long.
    const code = ErrorBodySchema.safeParse(await res.json().catch(() => null)).data?.error.code;
    throw new Error(`OpenAI HTTP ${res.status}${code ? ` ${code}` : ""}`);
  }
  const data = parseCompletion(await res.json());
  const choice = data.choices[0];
  if (choice.message.refusal) throw new Error("OpenAI refused");
  const parsed = parseGeneratedMessage(choice.message.content);

  return {
    content: { subject: parsed.subject, body: parsed.body, language: parsed.language, source: "llm" },
    meta: {
      response_id: data.id,
      model: data.model,
      finish_reason: choice.finish_reason,
      usage: data.usage,
      amenity_terms: parsed.amenity_terms,
      tour_verb: parsed.tour_verb,
    },
  };
}

// Errors name the failing fields, never their values: the values are message text.
function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
  throw new Error(`OpenAI returned a malformed ${what}: ${fields}`);
}

const parseCompletion = (data: unknown) => parseOrThrow(ChatCompletionSchema, data, "response");

// Not JSON.parse's own error: its message quotes the text it failed on, i.e. the message.
function parseGeneratedMessage(content: string | null | undefined) {
  let raw: unknown;
  try {
    raw = JSON.parse(content ?? "");
  } catch {
    throw new Error("OpenAI returned invalid JSON");
  }
  return parseOrThrow(GeneratedMessageSchema, raw, "message");
}

// Multi-word English amenity labels ("kids club") left as they are in a non-English message.
// Logged, not blocked: one untranslated label isn't worth dropping the message, but the rate
// shows whether the prompt is holding. Single words are skipped, since many are also the local
// word ("spa").
function logUntranslatedAmenities(testCase: TestCase, content: MessageContent): void {
  if (primaryLanguage(content.language) === "en") return;
  const text = `${content.subject ?? ""}\n${content.body}`.toLowerCase();
  const untranslated = (testCase.input.profile.amenity_interest ?? []).filter(
    (label) => label.trim().includes(" ") && text.includes(label.trim().toLowerCase()),
  );
  if (untranslated.length > 0) {
    // A count, not the labels: they're the user's interests.
    logForObservability(testCase.task_id, "untranslated_amenities", { language: content.language, count: untranslated.length });
  }
}

// A non-English email subject that still starts with the English "Tour". Logged, not blocked,
// like the amenities above.
function logUntranslatedTourVerb(testCase: TestCase, content: MessageContent): void {
  if (primaryLanguage(content.language) === "en" || !content.subject) return;
  if (/^\s*tour\b/i.test(content.subject)) {
    logForObservability(testCase.task_id, "untranslated_tour_verb", { language: content.language });
  }
}
