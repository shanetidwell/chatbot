// Subject and body from OpenAI (spec step 5).
//
// Env:
//   OPENAI_API_KEY      required; without it the template content is used instead.
//   OPENAI_MODEL        default "gpt-5-mini" (fast, strong at following format rules).
//   OPENAI_TIMEOUT_MS   default 10000.
//
// The runner (chatbot.ts) loads these from .env. Every call logs `llm_generated` with what OpenAI
// returned, including the subject/body text. That text has the user's first name in it, which is
// fine for local runs but should be dropped before these logs go anywhere they're kept.
//
// Only the fields listed in `promptInput` are sent: no city_interest, no `expected`, no other
// profile values, no last_interaction.

import { shortPropertyName } from "./actions.ts";
import { looseMoveTiming } from "./dates.ts";
import {
  OPT_OUT_TEXT,
  templateContent,
  tourWeekPhrase,
  type ContentContext,
  type ContentGenerator,
  type MessageContent,
} from "./message.ts";
import { logForObservability } from "./observability.ts";
import type { TestCase } from "./types.ts";

// Read at call time, not import time, so values loaded from .env after import still apply.
const model = () => process.env.OPENAI_MODEL ?? "gpt-5-mini";
const timeoutMs = () => Number(process.env.OPENAI_TIMEOUT_MS ?? 10_000);

// What came back besides the content: proof of a real call (response id, the exact model that
// answered) plus why it stopped and the token counts.
type ResponseMeta = { response_id: string; model: string; finish_reason: string; usage: unknown };

const SYSTEM_PROMPT = `You write outreach messages for an apartment leasing team. Return JSON {"subject", "body"}.

Brand style (all required):
- English only. Warm, brief, plain. No emojis, no hashtags.
- Body starts with "Hi <first_name>" exactly ("Hi <first_name>—..." for SMS, "Hi <first_name>," on its own line for email).
- Use only the facts given. Never mention a city, neighborhood, exact dates, phone numbers, emails, or any other personal detail.
- Move timing: say it loosely using move_timing as given (e.g. "a mid‑February move"); never write the exact move date.
- Fair Housing: describe the property and amenities, never the kind of person it suits. Never mention or imply family status, children, age, religion, race, national origin, sex, disability, or source of income.
- If include_opt_out_instructions is true, the body must end with opt_out_text, exactly as given.

SMS (channel "sms"):
- subject is null.
- One short paragraph, at most 300 characters including the opt-out line. No links.
- new lead: welcome them to the property; open lead: check in from the property.
- Say tours are available <tour_week>, ask whether they'd like to book a time on the full day names, then include reply_line exactly as given.

Email (channel "email"):
- subject: if subject_amenities is empty, exactly "Tour <property_name>". Otherwise exactly "Tour <property_name>—See the <subject_amenities> rooms you asked about".
- Body lines, separated by "\\n": greeting line; one or two sentences tying their move timing to the amenities (use amenity_phrases) and inviting them to book a visit this week to compare floor plans; "Book now → <tour_link>"; then the opt-out line if required.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: { type: ["string", "null"] },
    body: { type: "string" },
  },
};

const WEEKDAY_FULL: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday",
};
const AMENITY_PHRASE: Record<string, string> = { fitness: "24/7 fitness center" };

function joinList(items: string[], pairJoiner: string): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]}${pairJoiner}${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// The allow-listed facts the model sees.
function promptInput(testCase: TestCase, { channel, cta, send_at }: ContentContext) {
  const { constraints } = testCase.assertions;
  const amenities = testCase.input.profile.amenity_interest ?? [];
  const options = cta.options ?? [];
  return {
    channel,
    lifecycle_stage: testCase.lifecycle_stage,
    first_name: testCase.input.profile.first_name,
    property_name: shortPropertyName(testCase.input.property_name),
    move_timing: looseMoveTiming(testCase.input.move_date_target),
    amenity_phrases: amenities.map((a) => AMENITY_PHRASE[a] ?? a),
    subject_amenities: testCase.task_id.startsWith("prospect") ? joinList(amenities, " & ") : "",
    constraints,
    ...(channel === "sms"
      ? {
          tour_week: tourWeekPhrase(send_at, options),
          tour_days: options.map((o) => WEEKDAY_FULL[o] ?? o),
          reply_line: `Reply ${options.map((o, i) => `${i + 1} for ${o}`).join(", ")}.`,
        }
      : { tour_link: cta.link }),
    include_opt_out_instructions: constraints.include_opt_out_instructions,
    opt_out_text: OPT_OUT_TEXT[channel],
  };
}

async function callOpenAI(apiKey: string, input: unknown): Promise<{ content: MessageContent; meta: ResponseMeta }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs()),
    body: JSON.stringify({
      model: model(),
      reasoning_effort: "minimal",
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
  return {
    content: { subject: parsed.subject, body: parsed.body, source: "llm" },
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
      output: { subject: content.subject, body: content.body },
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
