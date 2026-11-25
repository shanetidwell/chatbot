// The call to action (spec step 3) and the next action (spec step 4).

import { addDays, dayOffset, WEEKDAY_ABBR, weekdayOf } from "./dates.ts";
import { logForObservability } from "./observability.ts";
import { shortPropertyName } from "./text.ts";
import type { Cta, NextAction, SupportedChannel, TestCase } from "./types.ts";

// ---------------------------------------------------------------------------
// CTA: book_tour -> schedule_tour. Email gets a link; SMS gets reply options.
// ---------------------------------------------------------------------------

export function buildCta(testCase: TestCase, channel: SupportedChannel, sendAt: string): Cta {
  const primaryCta = testCase.assertions.constraints.primary_cta;
  if (primaryCta !== "book_tour") {
    logForObservability(testCase.task_id, "unsupported_primary_cta", { primary_cta: primaryCta });
    throw new Error(`Unsupported primary_cta "${primaryCta}"`);
  }
  return channel === "email"
    ? { type: "schedule_tour", link: tourLink(testCase.input.property_name) }
    : { type: "schedule_tour", options: tourOptions(sendAt) };
}

// "Oak Ridge Apartments" -> "https://oakridge.example/tour"
// "Lomas del Río Apartments" -> "https://lomasdelrio.example/tour" (accents dropped, not the letter)
function tourLink(propertyName: string): string {
  const slug = shortPropertyName(propertyName)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return `https://${slug}.example/tour`;
}

// Two tour days for SMS reply options: the first two weekdays starting two days after the send
// date (send Tue 2025-12-09 -> ["Thu", "Fri"]).
function tourOptions(sendAt: string): string[] {
  const options: string[] = [];
  let date = addDays(sendAt.slice(0, 10), 2);
  while (options.length < 2) {
    const weekday = weekdayOf(date);
    const isWeekend = weekday === 0 || weekday === 6;
    if (!isWeekend) options.push(WEEKDAY_ABBR[weekday]);
    date = addDays(date, 1);
  }
  return options;
}

// ---------------------------------------------------------------------------
// next_action: new -> start_cadence, open -> follow_up_in_days.
// ---------------------------------------------------------------------------

export function buildNextAction(testCase: TestCase): NextAction {
  switch (testCase.lifecycle_stage) {
    case "new":
      // A new lead starts the short-horizon cadence for its task family:
      // "prospect_welcome_day0" -> "prospect_welcome_short_horizon".
      return {
        type: "start_cadence",
        name: `${testCase.task_id.replace(/_day\d+$/, "")}_short_horizon`,
      };
    case "open":
      return { type: "follow_up_in_days", value: dayOffset(testCase.task_id) };
  }
}
