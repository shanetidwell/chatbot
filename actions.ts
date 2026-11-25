// CTA, next action, and amenity joining.

import { hasConsent } from "./checks.ts";
import { addDays, dayOffset } from "./dates.ts";
import type { Channel, Cta, NextAction, TestCase } from "./types.ts";

// ---------------------------------------------------------------------------
// 1. Channel: the first preferred channel the user has opted in to.
// ---------------------------------------------------------------------------

export function pickChannel(testCase: TestCase): Channel | null {
  return testCase.channel_preferences.find((c) => hasConsent(testCase, c)) ?? null;
}

// ---------------------------------------------------------------------------
// 3. CTA: book_tour -> schedule_tour. Email gets a link; SMS gets reply options.
// ---------------------------------------------------------------------------

const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Oak Ridge Apartments" -> "Oak Ridge"
export function shortPropertyName(propertyName: string): string {
  return propertyName.replace(/\s*\bApartments\b\s*/gi, " ").trim();
}

// "Oak Ridge Apartments" -> "https://oakridge.example/tour"
function tourLink(propertyName: string): string {
  const slug = shortPropertyName(propertyName).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `https://${slug}.example/tour`;
}

// Two tour days for SMS reply options: the first two weekdays starting two days after the send
// date (send Tue 2025-12-09 -> ["Thu", "Fri"]).
function tourOptions(sendAt: string): string[] {
  const options: string[] = [];
  let date = addDays(sendAt.slice(0, 10), 2);
  while (options.length < 2) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) options.push(WEEKDAY_ABBR[weekday]);
    date = addDays(date, 1);
  }
  return options;
}

export function buildCta(testCase: TestCase, channel: Channel, sendAt: string): Cta {
  const primaryCta = testCase.assertions.constraints.primary_cta;
  if (primaryCta !== "book_tour") throw new Error(`Unsupported primary_cta "${primaryCta}"`);
  return channel === "email"
    ? { type: "schedule_tour", link: tourLink(testCase.input.property_name) }
    : { type: "schedule_tour", options: tourOptions(sendAt) };
}

// ---------------------------------------------------------------------------
// 4. next_action: new -> start_cadence, open -> follow_up_in_days.
// ---------------------------------------------------------------------------

export function buildNextAction(testCase: TestCase): NextAction {
  const n = dayOffset(testCase.task_id);
  switch (testCase.lifecycle_stage) {
    case "new":
      // A new lead starts the short-horizon cadence for its task family:
      // "prospect_welcome_day0" -> "prospect_welcome_short_horizon".
      return {
        type: "start_cadence",
        name: `${testCase.task_id.replace(/_day\d+$/, "")}_short_horizon`,
      };
    case "open":
      return { type: "follow_up_in_days", value: n };
  }
}

