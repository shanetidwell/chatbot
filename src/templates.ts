// Template content: the deterministic English subject and body, used when the LLM is unavailable
// or its output fails a check, and by the tests.
//
// Templates are English only. For a user whose language is something else, the template message
// fails the language_matched check and nothing is sent: better than messaging them in English.
//
// The body is filled in only from the fields in BodyInput, so city_interest, the `expected`
// block, and anything else not listed can't reach the message.

import { monthName, moveTiming, tourWeek, weekdayName, type TourWeek } from "./dates.ts";
import { ENGLISH_OPT_OUT, englishReplyLine, englishSubject, joinList, shortPropertyName, subjectAmenities } from "./text.ts";
import type { ContentGenerator, Cta, LifecycleStage, SupportedChannel } from "./types.ts";

type BodyInput = {
  channel: SupportedChannel;
  lifecycle_stage: LifecycleStage;
  first_name: string;
  property_name: string;
  amenity_interest: string[];
  move_date_target: string;
  send_at: string;
  cta: Cta;
};

export const templateContent: ContentGenerator = async (testCase, { channel, send_at, cta }) => {
  const { input } = testCase;
  const body = buildBody({
    channel,
    lifecycle_stage: testCase.lifecycle_stage,
    first_name: input.profile.first_name,
    property_name: input.property_name,
    amenity_interest: input.profile.amenity_interest ?? [],
    move_date_target: input.move_date_target,
    send_at,
    cta,
  });
  const optOut = testCase.assertions.constraints.include_opt_out_instructions ? ENGLISH_OPT_OUT[channel] : null;
  return {
    source: "template",
    language: "en",
    subject:
      channel === "email"
        ? englishSubject(input.property_name, subjectAmenities(testCase.task_id, input.profile.amenity_interest))
        : null,
    // Opt-out on its own line for email, same paragraph for SMS.
    body: optOut ? `${body}${channel === "email" ? "\n" : " "}${optOut}` : body,
  };
};

function buildBody(input: BodyInput): string {
  return input.channel === "sms" ? smsBody(input) : emailBody(input);
}

const WEEK_PHRASE: Record<TourWeek, string> = {
  this_week: "this week",
  next_week: "next week",
  next_few_days: "over the next few days",
};

// "Hi Taylor—welcome to Oak Ridge! Tours are available this week. Would you like to book a time
//  on Thursday or Friday? Reply 1 for Thu, 2 for Fri."
function smsBody(input: BodyInput): string {
  const name = shortPropertyName(input.property_name);
  const options = input.cta.options ?? [];
  const opener =
    input.lifecycle_stage === "new"
      ? `Hi ${input.first_name}—welcome to ${name}!`
      : `Hi ${input.first_name}—checking in from ${name}.`;
  const when = WEEK_PHRASE[tourWeek(input.send_at, options)];
  const days = options.map((o) => weekdayName(o, "en")).join(" or ");
  return `${opener} Tours are available ${when}. Would you like to book a time on ${days}? ${englishReplyLine(options)}`;
}

// Hi Taylor,
// Since you’re planning a mid‑February move, here’s a quick look at our pool and fitness.
// Book a visit this week to compare floor plans.
// Book now → https://oakridge.example/tour
function emailBody(input: BodyInput): string {
  const { part, month } = moveTiming(input.move_date_target);
  // Non-breaking hyphen, to match the brand copy in the samples.
  const timing = `Since you’re planning a ${part}‑${monthName(month, "en")} move`;
  const pitch =
    input.amenity_interest.length > 0
      ? `${timing}, here’s a quick look at our ${joinList(input.amenity_interest, " and ")}. Book a visit this week to compare floor plans.`
      : `${timing}, book a visit this week to compare floor plans.`;
  return [`Hi ${input.first_name},`, pitch, `Book now → ${input.cta.link}`].join("\n");
}
