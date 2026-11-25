// Channel selection (spec step 1) and consent.
// Consent overrides preference: we only ever send on a channel the user has opted in to.

import { logForObservability } from "./observability.ts";
import type { Channel, SupportedChannel, TestCase } from "./types.ts";

export function hasConsent(testCase: TestCase, channel: Channel): boolean {
  return testCase.consent[`${channel}_opt_in`] === true;
}

function isSupported(channel: Channel): channel is SupportedChannel {
  return channel === "sms" || channel === "email";
}

// The first preferred channel the user has opted in to that we can send on, or null if none.
// Voice isn't supported yet, so it's skipped and the next consented channel is used.
export function pickChannel(testCase: TestCase): SupportedChannel | null {
  const preferences = testCase.channel_preferences;
  const picked = preferences.filter(isSupported).find((c) => hasConsent(testCase, c)) ?? null;

  // Every preference ahead of the one we picked was skipped; record why.
  const considered = picked ? preferences.slice(0, preferences.indexOf(picked)) : preferences;
  const skipped = considered.map((channel) => ({
    channel,
    reason: isSupported(channel) ? "no_consent" : "unsupported",
  }));
  logForObservability(testCase.task_id, "channel_selected", {
    picked,
    preferred: preferences[0] ?? null,
    fell_back: picked !== null && picked !== preferences[0],
    skipped,
  });

  return picked;
}
