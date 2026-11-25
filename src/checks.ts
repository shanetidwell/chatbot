// Checks that gate sending (spec step 6): the required_states (consent, Fair Housing, brand
// style), the no-PII rule, and that the message is in the user's language. runChecks returns the
// names of the checks that failed.
//
// Messages can be in any language, so brand style and no-PII check things that don't depend on
// it (first name, the STOP keyword, reply numbers, links, length, profile values). Fair Housing
// is the exception: its phrase list is English. The same list is sent to the language model
// (llm.ts), which is told to avoid these phrases and their equivalents in the message language;
// for other languages that prompt is the guard, and the regexes here catch English slips.

import { hasConsent } from "./channel.ts";
import { logForObservability } from "./observability.ts";
import { OPT_OUT_KEYWORD, primaryLanguage, shortPropertyName, SMS_MAX_LENGTH } from "./text.ts";
import type { CheckName, NextMessage, TestCase } from "./types.ts";
import { VOICE_MAX_LENGTH } from "./voice.ts";

// `writtenIn` is the language the content was written in (MessageContent.language).
export function runChecks(message: NextMessage, testCase: TestCase, writtenIn: string): CheckName[] {
  const { required_states, constraints } = testCase.assertions;
  const texts = [message.subject ?? "", message.body];
  const checks: Record<CheckName, () => boolean> = {
    language_matched: () => primaryLanguage(writtenIn) === primaryLanguage(testCase.input.language),
    consent_verified: () => hasConsent(testCase, message.channel),
    fair_housing_check_passed: () => passesFairHousing(texts, testCase),
    brand_style_applied: () => passesBrandStyle(message, testCase),
    no_pii_leak: () => passesNoPii(texts, testCase),
  };

  const toRun = ["language_matched", ...required_states] as CheckName[];
  if (constraints.no_pii_leak) toRun.push("no_pii_leak");

  const failed = toRun.filter((name) => {
    const check = checks[name];
    if (!check) {
      logForObservability(testCase.task_id, "unknown_required_state", { required_state: name });
      throw new Error(`Unknown required state "${name}"`);
    }
    return !check();
  });
  logForObservability(testCase.task_id, "checks_ran", { ran: toRun, failed });
  return failed;
}

// ---------------------------------------------------------------------------
// Fair Housing
// ---------------------------------------------------------------------------

// Phrases that state or imply a preference about a protected class. One list for both sides:
// `pattern` is what the check matches (English), `examples` is how the phrases are shown to the
// language model so it can avoid them, and their equivalents, in any language. Keep the two in
// step when editing an entry.
export const FAIR_HOUSING_PHRASES: { protects: string; pattern: RegExp; examples: string[] }[] = [
  { protects: "familial status", pattern: /\b(no|without) (kids|children)\b/i, examples: ["no kids", "without children"] },
  { protects: "familial status / age", pattern: /\badults? only\b/i, examples: ["adults only"] },
  {
    protects: "familial status / age / sex",
    pattern: /\b(perfect|ideal|great) for (singles|couples|families|young professionals|students|seniors|retirees)\b/i,
    examples: ["perfect for singles", "ideal for couples", "great for families", "ideal for young professionals", "great for students", "perfect for seniors", "ideal for retirees"],
  },
  { protects: "familial status", pattern: /\b(family|families)[- ]friendly\b/i, examples: ["family-friendly"] },
  { protects: "age", pattern: /\bmature (person|persons|individuals|adults)\b/i, examples: ["mature adults", "mature person"] },
  {
    protects: "religion",
    pattern: /\b(christian|jewish|muslim|catholic|hindu|buddhist)\b/i,
    examples: ["Christian", "Jewish", "Muslim", "Catholic", "Hindu", "Buddhist"],
  },
  {
    protects: "race / national origin",
    pattern: /\b(white|black|hispanic|latino|latina|asian)\b/i,
    examples: ["white", "black", "Hispanic", "Latino", "Latina", "Asian"],
  },
  // Describing accessibility features ("wheelchair-accessible") is allowed; excluding people is not.
  { protects: "disability", pattern: /\bable[- ]bodied\b/i, examples: ["able-bodied"] },
  { protects: "disability", pattern: /\bno wheelchairs?\b/i, examples: ["no wheelchairs"] },
  {
    protects: "disability",
    pattern: /\b(not suitable|unsuitable) for (the )?(disabled|handicapped)\b/i,
    examples: ["not suitable for the disabled", "unsuitable for handicapped"],
  },
  {
    protects: "national origin",
    pattern: /\b(english[- ]speaking|native[- ]born|immigrants?|citizens? only)\b/i,
    examples: ["English-speaking", "native-born", "immigrants", "citizens only"],
  },
  { protects: "source of income", pattern: /\b(no section 8|no vouchers|section 8)\b/i, examples: ["no Section 8", "no vouchers"] },
  { protects: "sex", pattern: /\b(bachelor|man cave|his and hers)\b/i, examples: ["bachelor pad", "man cave", "his and hers"] },
];

function passesFairHousing(texts: string[], testCase: TestCase): boolean {
  const masked = texts.map((t) => maskInputValues(t, testCase));
  logMaskingApplied(texts, masked, testCase);
  const matched = FAIR_HOUSING_PHRASES.filter(({ pattern }) => masked.some((t) => pattern.test(t))).map(
    ({ pattern }) => pattern.source,
  );
  if (matched.length > 0) logForObservability(testCase.task_id, "fair_housing_violation", { patterns: matched });
  return matched.length === 0;
}

// How often masking actually changed the text. A high rate means templates pull in input values
// that look like risky phrases more than expected.
function logMaskingApplied(texts: string[], masked: string[], testCase: TestCase): void {
  const changed = texts.filter((t, i) => t !== masked[i]).length;
  if (changed > 0) logForObservability(testCase.task_id, "input_values_masked", { texts_changed: changed });
}

// ---------------------------------------------------------------------------
// Brand style
// ---------------------------------------------------------------------------

// Greets by first name, ends with the opt-out instructions when required, and fits the channel's
// format: SMS is short, has no subject or links, and numbers the reply options; voice (the call
// script) is the same, with its own length cap and no symbols that read badly aloud; email has a
// subject naming the property and the tour link in the body. None of this depends on the
// message language.
function passesBrandStyle(message: NextMessage, testCase: TestCase): boolean {
  const failed = brandStyleFailures(message, testCase);
  if (failed.length > 0) logForObservability(testCase.task_id, "brand_style_failed", { rules: failed });
  return failed.length === 0;
}

function brandStyleFailures(message: NextMessage, testCase: TestCase): string[] {
  const { body, cta } = message;
  const failed: string[] = [];
  if (!greetsByFirstName(body, testCase.input.profile.first_name)) failed.push("greeting");
  if (testCase.assertions.constraints.include_opt_out_instructions && !endsWithOptOut(body, message.channel)) {
    failed.push("opt_out_last");
  }
  if (message.channel === "sms" || message.channel === "voice") {
    const ch = message.channel;
    if (message.subject !== null) failed.push(`${ch}_subject`);
    if (body.length > (ch === "sms" ? SMS_MAX_LENGTH : VOICE_MAX_LENGTH)) failed.push(`${ch}_length`);
    if (/https?:\/\//.test(body)) failed.push(`${ch}_link`);
    if (!(cta.options ?? []).every((_, i) => new RegExp(`(?<!\\d)${i + 1}(?!\\d)`).test(body))) failed.push(`${ch}_reply_numbers`);
    // Read aloud: symbols text-to-speech reads out literally or skips.
    if (ch === "voice" && /[—→&/#@]|\p{Extended_Pictographic}/u.test(body)) failed.push("voice_unspeakable");
  } else {
    if (!message.subject.includes(shortPropertyName(testCase.input.property_name))) failed.push("subject_property");
    if (!cta.link || !body.includes(cta.link)) failed.push("email_link");
  }
  return failed;
}

// The first name comes right after a short greeting at the very start ("Hi Taylor", "Hola Sofía",
// "Bonjour Sofía"), as a whole word.
function greetsByFirstName(body: string, firstName: string): boolean {
  const opening = body.trimStart().slice(0, 20 + firstName.length);
  return new RegExp(`(^|[^\\p{L}])${escapeRegExp(firstName)}($|[^\\p{L}])`, "u").test(opening);
}

// The opt-out keyword is in the last sentence (SMS) or last line (email), in any language:
// "Reply STOP to opt out." / "Responde STOP para cancelar."
function endsWithOptOut(body: string, channel: NextMessage["channel"]): boolean {
  const trimmed = body.trim();
  const last = channel === "email" ? trimmed.split("\n").pop()! : trimmed.split(/(?<=[.!?])\s+/).pop()!;
  return new RegExp(`\\b${OPT_OUT_KEYWORD}\\b`).test(last);
}

// ---------------------------------------------------------------------------
// No PII
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_PATTERN = /\+?\d[\d\s().-]{8,}\d/;

// First name and amenity interests are allowed (the spec uses both). Every other profile value,
// the exact move date, the last-interaction timestamp, and any email/phone must stay out.
// Profile values are also checked piece by piece ("Richardson, TX" -> "Richardson"), as whole
// words, so a partial leak is caught. Pieces under 3 characters ("TX") are too short to check
// on their own. The property name and first name are public, so they're masked out first.
function passesNoPii(texts: string[], testCase: TestCase): boolean {
  const { profile, move_date_target, last_interaction } = testCase.input;
  const profileValues = Object.entries(profile)
    .filter(([key, value]) => key !== "first_name" && key !== "amenity_interest" && typeof value === "string")
    .map(([, value]) => (value as string).trim())
    .filter((value) => value.length > 0);
  const words = profileValues.flatMap((value) => [value, ...value.split(",").map((part) => part.trim())]);
  const forbiddenWords = [...new Set(words)]
    .filter((w) => w.length >= 3)
    .map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(w)}($|[^\\p{L}\\p{N}])`, "iu"));
  // Categories only: logging the matched value would itself leak the PII.
  const categories = new Set<string>();
  for (const raw of texts) {
    const t = maskInputValues(raw, testCase);
    if (forbiddenWords.some((re) => re.test(t))) categories.add("profile_value");
    if (move_date_target.trim() && t.includes(move_date_target)) categories.add("move_date_target");
    if (last_interaction.trim() && t.includes(last_interaction)) categories.add("last_interaction");
    if (EMAIL_PATTERN.test(t)) categories.add("email");
    if (PHONE_PATTERN.test(t)) categories.add("phone");
  }
  if (categories.size > 0) logForObservability(testCase.task_id, "pii_leak_detected", { categories: [...categories] });
  return categories.size === 0;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// Blank out values that come from the input record itself (the user's first name, the property
// name, amenity names), so e.g. "Hi Christian" or "White Oak" isn't read as a protected-class
// phrase written by us. Longest first, so "White Oak Apartments" goes before "White Oak".
function maskInputValues(text: string, testCase: TestCase): string {
  const { property_name, profile } = testCase.input;
  const values = [profile.first_name, property_name, shortPropertyName(property_name), ...(profile.amenity_interest ?? [])]
    .filter((v) => v.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  return values.reduce((t, v) => t.replace(new RegExp(escapeRegExp(v), "gi"), " "), text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
