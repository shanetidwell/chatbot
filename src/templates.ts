// Template content: the deterministic subject and body, used when the LLM is unavailable or its
// output fails a check, and by the tests.
//
// The body is filled in only from the fields in BodyInput, so city_interest, the `expected`
// block, and anything else not listed can't reach the message.

import { fullDayName, looseMoveTiming, tourWeekPhrase } from "./dates.ts";
import { amenityPhrases, buildSubject, joinList, replyChoices, shortPropertyName } from "./text.ts";
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
  return {
    source: "template",
    subject: buildSubject(testCase, channel),
    body: buildBody({
      channel,
      lifecycle_stage: testCase.lifecycle_stage,
      first_name: input.profile.first_name,
      property_name: input.property_name,
      amenity_interest: input.profile.amenity_interest ?? [],
      move_date_target: input.move_date_target,
      send_at,
      cta,
    }),
  };
};

// The body without the opt-out line; processInput appends that.
function buildBody(input: BodyInput): string {
  return input.channel === "sms" ? smsBody(input) : emailBody(input);
}

// "Hi Taylor—welcome to Oak Ridge! Tours are available this week. Would you like to book a time
//  on Thursday or Friday? Reply 1 for Thu, 2 for Fri."
function smsBody(input: BodyInput): string {
  const name = shortPropertyName(input.property_name);
  const options = input.cta.options ?? [];
  const opener =
    input.lifecycle_stage === "new"
      ? `Hi ${input.first_name}—welcome to ${name}!`
      : `Hi ${input.first_name}—checking in from ${name}.`;
  const when = tourWeekPhrase(input.send_at, options);
  const days = options.map(fullDayName).join(" or ");
  return `${opener} Tours are available ${when}. Would you like to book a time on ${days}? Reply ${replyChoices(options)}.`;
}

// Hi Taylor,
// Since you’re planning a mid‑February move, here’s a quick look at our pool and 24/7 fitness
// center. Book a visit this week to compare floor plans.
// Book now → https://oakridge.example/tour
function emailBody(input: BodyInput): string {
  const timing = `Since you’re planning a ${looseMoveTiming(input.move_date_target)} move`;
  const pitch =
    input.amenity_interest.length > 0
      ? `${timing}, here’s a quick look at our ${joinList(amenityPhrases(input.amenity_interest), " and ")}. Book a visit this week to compare floor plans.`
      : `${timing}, book a visit this week to compare floor plans.`;
  return [`Hi ${input.first_name},`, pitch, `Book now → ${input.cta.link}`].join("\n");
}
