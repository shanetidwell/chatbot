// Checks that gate sending: required_states (consent, Fair Housing, brand style) and no-PII.

import { OPT_OUT_TEXT } from "./message.ts";
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
  /\b(able[- ]bodied|handicapped|disabled|wheelchair)\b/i,
  /\b(english[- ]speaking|native[- ]born|immigrants?|citizens? only)\b/i,
  /\b(no section 8|no vouchers|section 8)\b/i,
  /\b(bachelor|man cave|his and hers)\b/i,
];

function passesFairHousing(texts: string[]): boolean {
  return texts.every((t) => FAIR_HOUSING_PATTERNS.every((p) => !p.test(t)));
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
function passesNoPii(texts: string[], testCase: TestCase): boolean {
  const { profile, move_date_target, last_interaction } = testCase.input;
  const forbidden = Object.entries(profile)
    .filter(([key, value]) => key !== "first_name" && key !== "amenity_interest" && typeof value === "string")
    .map(([, value]) => (value as string).toLowerCase());
  forbidden.push(move_date_target, last_interaction);
  return texts.every((t) => {
    const lower = t.toLowerCase();
    return (
      forbidden.every((f) => !lower.includes(f.toLowerCase())) &&
      !EMAIL_PATTERN.test(t) &&
      !PHONE_PATTERN.test(t)
    );
  });
}

export function runChecks(message: NextMessage, testCase: TestCase): CheckName[] {
  const { required_states, constraints } = testCase.assertions;
  const texts = [message.subject ?? "", message.body];
  const results: Record<CheckName, () => boolean> = {
    consent_verified: () => hasConsent(testCase, message.channel),
    fair_housing_check_passed: () => passesFairHousing(texts),
    brand_style_applied: () => passesBrandStyle(message, testCase),
    no_pii_leak: () => passesNoPii(texts, testCase),
  };
  const toRun = [...required_states] as CheckName[];
  if (constraints.no_pii_leak) toRun.push("no_pii_leak");
  return toRun.filter((name) => {
    const check = results[name];
    if (!check) throw new Error(`Unknown required state "${name}"`);
    return !check();
  });
}

export function blocked(failed: CheckName[]): ProcessResult {
  const next_action: BlockedAction = { type: "resolve_failed_checks", failed_checks: failed };
  return { next_message: null, next_action };
}
