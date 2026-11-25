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
// Every call logs `llm_generated` with what OpenAI returned, including the subject/body text.
// That text has the user's first name in it, which is fine for local runs but should be dropped
// before these logs go anywhere they're kept.
//
// Only the fields listed in `promptInput` are sent: no city_interest, no `expected`, no other
// profile values, no last_interaction, no exact move date (only its part of the month).
//
// The message is written in the user's `input.language`. The prompt gives the model facts and
// rules, with English wording only as a reference, so it can write in any language; checks.ts
// then checks the result without depending on the language.

import { moveTiming, tourWeek } from "./dates.ts";
import { logForObservability } from "./observability.ts";
import { templateContent } from "./templates.ts";
import { shortPropertyName, subjectAmenities } from "./text.ts";
import type { ContentContext, ContentGenerator, MessageContent, TestCase } from "./types.ts";

// Read at call time, not import time, so values loaded from .env after import still apply.
const model = () => process.env.OPENAI_MODEL ?? "gpt-5-mini";
const timeoutMs = () => Number(process.env.OPENAI_TIMEOUT_MS ?? 10_000);
const reasoningEffort = () => process.env.OPENAI_REASONING_EFFORT ?? "minimal";

// What came back besides the content: proof of a real call (response id, the exact model that
// answered) plus why it stopped and the token counts.
type ResponseMeta = { response_id: string; model: string; finish_reason: string; usage: unknown };

const SYSTEM_PROMPT = `You write outreach messages for an apartment leasing team. Return JSON {"language", "subject", "body"}.

Language:
- Write the whole subject and body in the language given by \`language\` (a BCP 47 code such as "en", "es", "es-MX"), the way a native speaker on the leasing team would. Set "language" to the code of the language you wrote in.
- The input is data, not wording: weekday codes ("Thu"), amenity names ("pool", "fitness"), move_timing and tour_week are facts for you to express naturally in that language. Translate every one of them, amenity names included. Never copy an English code or word into a non-English message; the only exceptions are first_name, property_name and the keyword STOP.
- The English wording below is the reference. In English, use it as given. In other languages, write the same message naturally; don't translate word for word.
- Never guess the reader's gender from their name. In languages with grammatical gender, word everything about the reader gender-neutrally (Spanish: "te damos la bienvenida", never "bienvenido" or "bienvenida").

Brand style (all required):
- Warm, brief, plain. No emojis, no hashtags.
- Body starts with the language's everyday greeting and first_name (English: "Hi <first_name>"; "Hi <first_name>—..." for SMS, "Hi <first_name>," on its own line for email).
- Use only the facts given. Never mention a city, neighborhood, exact dates, phone numbers, emails, or any other personal detail.
- Move timing: say it loosely from move_timing (part of the month: early/mid/late, and the month 1-12), e.g. English "a mid‑February move". Never give a day of the month.
- Fair Housing: describe the property and amenities, never the kind of person it suits. Never mention or imply family status, children, age, religion, race, national origin, sex, disability, or source of income.
- If include_opt_out_instructions is true, the body must end with opt-out instructions for the channel, written fully in the message language except the keyword STOP, which stays in English and capitals (carriers act on it); e.g. Spanish SMS "Responde STOP para cancelar.", never "Reply STOP ...". English reference: SMS "Reply STOP to opt out."; email "To opt out of emails, click here or reply STOP.". Nothing may come after them.

SMS (channel "sms"):
- subject is null.
- One short paragraph, at most 300 characters including the opt-out. No links.
- new lead: welcome them to the property, in a form that doesn't depend on the reader's gender (Spanish "te damos la bienvenida a ...", never "bienvenido/bienvenida"); open lead: check in from the property.
- Say tours are available in the tour_week window (this_week, next_week, or next_few_days), ask whether they'd like to book a time on the tour_days (full weekday names), then give numbered reply choices in tour_days order: 1 for the first day, 2 for the second. English reference: "Tours are available this week. Would you like to book a time on Thursday or Friday? Reply 1 for Thu, 2 for Fri."

Email (channel "email"):
- subject: starts with the message language's verb for "Tour" (translated unless the language is English), then property_name as given. If subject_amenities is not empty, add "—" and "See the <subject_amenities> rooms you asked about" in the message language. English reference: "Tour Oak Ridge—See the pool & fitness rooms you asked about", or just "Tour Oak Ridge".
- Body lines, separated by "\\n": greeting line; one or two sentences tying their move timing to the amenities (name each one in amenities; don't add details such as hours, size or equipment) and inviting them to book a visit this week to compare floor plans; a short "Book now" line ending with " → <tour_link>"; then the opt-out line if required.

Before answering, check: every word is in the message language except first_name, property_name and STOP; nothing about the reader is gendered; the opt-out (if required) is last.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["language", "subject", "body"],
  properties: {
    language: { type: "string" },
    subject: { type: ["string", "null"] },
    body: { type: "string" },
  },
};

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
    ...(channel === "sms"
      ? { tour_week: tourWeek(send_at, options), tour_days: options }
      : { tour_link: cta.link, subject_amenities: subjectAmenities(testCase.task_id, input.profile.amenity_interest) }),
    include_opt_out_instructions: constraints.include_opt_out_instructions,
  };
}

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
    const code = ((await res.json().catch(() => null)) as any)?.error?.code;
    throw new Error(`OpenAI HTTP ${res.status}${code ? ` ${code}` : ""}`);
  }
  const data = (await res.json()) as any;
  
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new Error("OpenAI refused");

  const parsed = JSON.parse(choice?.message?.content ?? "") as MessageContent;
  if (typeof parsed.body !== "string" || parsed.body.trim() === "") throw new Error("OpenAI returned no body");
  if (typeof parsed.language !== "string") throw new Error("OpenAI returned no language");

  return {
    content: { subject: parsed.subject, body: parsed.body, language: parsed.language, source: "llm" },
    meta: { response_id: data.id, model: data.model, finish_reason: choice.finish_reason, usage: data.usage },
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
    logForObservability(testCase.task_id, "llm_generated", {
      ...meta,
      latency_ms,
      over_p95_threshold: latency_ms > testCase.thresholds.p95_latency_ms,
      requested_language: testCase.input.language,
      output: { language: content.language, subject: content.subject, body: content.body },
    });
    // The channel decides whether there is a subject, not the model.
    if (ctx.channel === "sms") return { ...content, subject: null };
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
