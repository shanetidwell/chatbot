// Channel selection (spec step 1) and consent.
// Consent overrides preference: we only ever send on a channel the user has opted in to.

import { logForObservability } from "./observability.ts";
import type { Channel, TestCase } from "./types.ts";

export function hasConsent(testCase: TestCase, channel: Channel): boolean {
  return testCase.consent[`${channel}_opt_in`] === true;
}

// The first preferred channel the user has opted in to, or null if none. For voice we don't
// place the call; the message is the call script (see voice.ts).
export function pickChannel(testCase: TestCase): Channel | null {
  const preferences = testCase.channel_preferences;
  const picked = preferences.find((c) => hasConsent(testCase, c)) ?? null;

  // Every preference ahead of the one we picked was skipped for lack of consent.
  const considered = picked ? preferences.slice(0, preferences.indexOf(picked)) : preferences;
  logForObservability(testCase.task_id, "channel_selected", {
    picked,
    preferred: preferences[0] ?? null,
    fell_back: picked !== null && picked !== preferences[0],
    skipped: considered.map((channel) => ({ channel, reason: "no_consent" })),
  });

  return picked;
}
