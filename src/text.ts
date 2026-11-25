// Wording rules shared by the template generator, the LLM prompt and the brand-style check, so
// all three agree on exactly how names, lists, subjects, reply options and opt-out lines read.

import type { SupportedChannel, TestCase } from "./types.ts";

// "Oak Ridge Apartments" -> "Oak Ridge". Only a trailing "Apartments" is dropped, so
// "The Apartments at Legacy" stays as is, and a name that is just "Apartments" is kept whole.
export function shortPropertyName(propertyName: string): string {
  const name = propertyName.trim();
  const short = name.replace(/\s+Apartments$/i, "").trim();
  return short.length > 0 ? short : name;
}

// ["a", "b"] -> "a<pair>b"; ["a", "b", "c"] -> "a, b, and c"
export function joinList(items: string[], pairJoiner: string): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]}${pairJoiner}${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Subject (email only)
// ---------------------------------------------------------------------------

// The amenities named in a prospect's subject line ("pool & fitness"), or "" for none.
// Only prospects (task_id starting with "prospect") get them.
export function subjectAmenities(testCase: TestCase): string {
  if (!testCase.task_id.startsWith("prospect")) return "";
  return joinList(testCase.input.profile.amenity_interest ?? [], " & ");
}

// "Tour Oak Ridge—See the pool & fitness rooms you asked about", or just "Tour Oak Ridge".
// SMS has no subject.
export function buildSubject(testCase: TestCase, channel: SupportedChannel): string | null {
  if (channel !== "email") return null;
  const base = `Tour ${shortPropertyName(testCase.input.property_name)}`;
  const amenities = subjectAmenities(testCase);
  return amenities ? `${base}—See the ${amenities} rooms you asked about` : base;
}

// ---------------------------------------------------------------------------
// SMS reply options and opt-out
// ---------------------------------------------------------------------------

export const SMS_MAX_LENGTH = 320;

// ["Thu", "Fri"] -> "1 for Thu, 2 for Fri"
export function replyChoices(options: string[]): string {
  return options.map((o, i) => `${i + 1} for ${o}`).join(", ");
}

export const OPT_OUT_TEXT: Record<SupportedChannel, string> = {
  sms: "Reply STOP to opt out.",
  email: "To opt out of emails, click here or reply STOP.",
};

// Ends the body with the channel's opt-out line when the constraints ask for it
// (and it isn't there already): on its own line for email, same paragraph for SMS.
export function appendOptOut(body: string, testCase: TestCase, channel: SupportedChannel): string {
  if (!testCase.assertions.constraints.include_opt_out_instructions) return body;
  const optOut = OPT_OUT_TEXT[channel];
  if (body.endsWith(optOut)) return body;
  return channel === "email" ? `${body}\n${optOut}` : `${body} ${optOut}`;
}
