// Checks that gate sending: required_states (consent, Fair Housing, brand style) and no-PII.

import { shortPropertyName } from "./actions.ts";
import { OPT_OUT_TEXT } from "./message.ts";
import { logForObservability } from "./observability.ts";
import type { BlockedAction, Channel, CheckName, NextMessage, ProcessResult, TestCase } from "./types.ts";

export function hasConsent(testCase: TestCase, channel: Channel): boolean {
  return testCase.consent[`${channel}_opt_in`] === true;
}

// ---------------------------------------------------------------------------
// 6. Checks: required_states (consent, Fair Housing, brand style) and no-PII.
// ---------------------------------------------------------------------------

// Phrases that state or imply a preference about a protected class.
const FAIR_HOUSING_PATTERNS: RegExp[] = [
  /\b(no|without) (kids|children)\b/i,
  /\badults? only\b/i,
  /\b(perfect|ideal|great) for (singles|couples|families|young professionals|students|seniors|retirees)\b/i,
  /\b(family|families)[- ]friendly\b/i,
  /\bmature (person|persons|individuals|adults)\b/i,
  /\b(christian|jewish|muslim|catholic|hindu|buddhist)\b/i,
  /\b(white|black|hispanic|latino|latina|asian)\b/i,
  // Describing accessibility features ("wheelchair-accessible") is allowed; excluding people is not.
  /\bable[- ]bodied\b/i,
  /\bno wheelchairs?\b/i,
  /\b(not suitable|unsuitable) for (the )?(disabled|handicapped)\b/i,
  /\b(english[- ]speaking|native[- ]born|immigrants?|citizens? only)\b/i,
  /\b(no section 8|no vouchers|section 8)\b/i,
  /\b(bachelor|man cave|his and hers)\b/i,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function passesFairHousing(texts: string[], testCase: TestCase): boolean {
  const masked = texts.map((t) => maskInputValues(t, testCase));
  logMaskingApplied(texts, masked, testCase);
  const matched = FAIR_HOUSING_PATTERNS.filter((p) => masked.some((t) => p.test(t))).map((p) => p.source);
  if (matched.length > 0) logForObservability(testCase.task_id, "fair_housing_violation", { patterns: matched });
  return matched.length === 0;
}

// How often masking actually changed the text. A high rate means templates pull in input values
// that look like risky phrases more than expected.
function logMaskingApplied(texts: string[], masked: string[], testCase: TestCase): void {
  const changed = texts.filter((t, i) => t !== masked[i]).length;
  if (changed > 0) logForObservability(testCase.task_id, "input_values_masked", { texts_changed: changed });
}

function passesBrandStyle(message: NextMessage, testCase: TestCase): boolean {
  const firstName = testCase.input.profile.first_name;
  const { body, cta } = message;
  if (!body.startsWith(`Hi ${firstName}`)) return false;
  if (testCase.assertions.constraints.include_opt_out_instructions) {
    if (!body.endsWith(OPT_OUT_TEXT[message.channel])) return false;
  }
  if (message.channel === "sms") {
    const replyLine = (cta.options ?? []).map((o, i) => `${i + 1} for ${o}`).join(", ");
    return message.subject === null && body.length <= 320 && !/https?:\/\//.test(body) && body.includes(replyLine);
  }
  // email
  return message.subject.startsWith("Tour ") && !!cta.link && body.includes(cta.link);
}

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

export function runChecks(message: NextMessage, testCase: TestCase): CheckName[] {
  const { required_states, constraints } = testCase.assertions;
  const texts = [message.subject ?? "", message.body];
  const results: Record<CheckName, () => boolean> = {
    consent_verified: () => hasConsent(testCase, message.channel),
    fair_housing_check_passed: () => passesFairHousing(texts, testCase),
    brand_style_applied: () => passesBrandStyle(message, testCase),
    no_pii_leak: () => passesNoPii(texts, testCase),
  };
  const toRun = [...required_states] as CheckName[];
  if (constraints.no_pii_leak) toRun.push("no_pii_leak");
  const failed = toRun.filter((name) => {
    const check = results[name];
    if (!check) {
      logForObservability(testCase.task_id, "unknown_required_state", { required_state: name });
      throw new Error(`Unknown required state "${name}"`);
    }
    return !check();
  });
  logForObservability(testCase.task_id, "checks_ran", { ran: toRun, failed });
  return failed;
}

export function blocked(failed: CheckName[]): ProcessResult {
  const next_action: BlockedAction = { type: "resolve_failed_checks", failed_checks: failed };
  return { next_message: null, next_action };
}
