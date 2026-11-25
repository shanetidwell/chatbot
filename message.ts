// Message content: subject and body from templates filled in with the input.

import { shortPropertyName } from "./actions.ts";
import { looseMoveTiming } from "./dates.ts";
import type { Channel, Cta, TestCase } from "./types.ts";

// ["pool", "fitness"] -> "pool & fitness"; ["pool", "fitness", "spa"] -> "pool, fitness, and spa"
function joinAmenities(amenities: string[]): string {
  if (amenities.length <= 1) return amenities.join("");
  if (amenities.length === 2) return `${amenities[0]} & ${amenities[1]}`;
  return `${amenities.slice(0, -1).join(", ")}, and ${amenities[amenities.length - 1]}`;
}

export function buildSubject(testCase: TestCase, channel: Channel): string | null {
  if (channel !== "email") return null;
  const base = `Tour ${shortPropertyName(testCase.input.property_name)}`;
  if (!testCase.task_id.startsWith("prospect")) return base;
  const amenities = testCase.input.profile.amenity_interest ?? [];
  return amenities.length > 0
    ? `${base}—See the ${joinAmenities(amenities)} rooms you asked about`
    : base;
}

export const OPT_OUT_TEXT: Record<"sms" | "email", string> = {
  sms: "Reply STOP to opt out.",
  email: "To opt out of emails, click here or reply STOP.",
};

// The body is built from a fixed template, filled in only from the fields below, so
// city_interest, the `expected` block, and anything else not listed can't reach the message.
type BodyInput = {
  channel: "sms" | "email";
  lifecycle_stage: TestCase["lifecycle_stage"];
  first_name: string;
  property_name: string;
  amenity_interest: string[];
  move_date_target: string;
  cta: Cta;
};

const WEEKDAY_FULL: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
};

// How each amenity is described in a body. Unlisted amenities are used as-is.
const AMENITY_PHRASE: Record<string, string> = {
  fitness: "24/7 fitness center",
};


// ["pool", "fitness"] -> "pool and 24/7 fitness center"
function describeAmenities(amenities: string[]): string {
  const phrases = amenities.map((a) => AMENITY_PHRASE[a] ?? a);
  if (phrases.length <= 2) return phrases.join(" and ");
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

export function buildBody(input: BodyInput): string {
  const name = shortPropertyName(input.property_name);

  if (input.channel === "sms") {
    const options = input.cta.options ?? [];
    const days = options.map((o) => WEEKDAY_FULL[o] ?? o).join(" or ");
    const replies = options.map((o, i) => `${i + 1} for ${o}`).join(", ");
    const opener =
      input.lifecycle_stage === "new"
        ? `Hi ${input.first_name}—welcome to ${name}!`
        : `Hi ${input.first_name}—checking in from ${name}.`;
    return `${opener} Tours are available this week. Would you like to book a time on ${days}? Reply ${replies}.`;
  }

  // email
  const timing = `Since you’re planning a ${looseMoveTiming(input.move_date_target)} move`;
  const pitch =
    input.amenity_interest.length > 0
      ? `${timing}, here’s a quick look at our ${describeAmenities(input.amenity_interest)}. Book a visit this week to compare floor plans.`
      : `${timing}, book a visit this week to compare floor plans.`;
  return [`Hi ${input.first_name},`, pitch, `Book now → ${input.cta.link}`].join("\n");
}

// Template body, then the exact opt-out line when the constraints ask for it.
export function finishBody(body: string, testCase: TestCase, channel: "sms" | "email"): string {
  if (!testCase.assertions.constraints.include_opt_out_instructions) return body;
  const optOut = OPT_OUT_TEXT[channel];
  if (body.endsWith(optOut)) return body;
  return channel === "email" ? `${body}\n${optOut}` : `${body} ${optOut}`;
}
