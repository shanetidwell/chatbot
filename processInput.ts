import { buildCta, buildNextAction, pickChannel } from "./actions.ts";
import { blocked, runChecks } from "./checks.ts";
import { computeSendAt } from "./dates.ts";
import { buildBody, buildSubject, finishBody } from "./message.ts";
import type { NextMessage, ProcessResult, TestCase } from "./types.ts";

// ---------------------------------------------------------------------------
// processInput: the spec's steps, in the order it lists them.
// ---------------------------------------------------------------------------

export function processInput(testCase: TestCase): ProcessResult {
  // 1. Channel. No consented (and supported) channel means nothing can be sent yet.
  const channel = pickChannel(testCase);
  if (!channel) return blocked(["consent_verified"]);

  // 2-4. Timing, CTA, next action.
  const send_at = computeSendAt(testCase);
  const cta = buildCta(testCase, channel, send_at);
  const nextAction = buildNextAction(testCase);

  // 5. Content.
  const subject = buildSubject(testCase, channel);
  const { profile } = testCase.input;
  const rawBody = buildBody({
    channel,
    lifecycle_stage: testCase.lifecycle_stage,
    first_name: profile.first_name,
    property_name: testCase.input.property_name,
    amenity_interest: profile.amenity_interest ?? [],
    move_date_target: testCase.input.move_date_target,
    send_at,
    cta,
  });
  const body = finishBody(rawBody, testCase, channel);
  const message: NextMessage =
    channel === "email"
      ? { channel, send_at, subject: subject!, body, cta }
      : { channel, send_at, subject: null, body, cta };

  // 6. Checks. Any failure: don't send, don't advance.
  const failed = runChecks(message, testCase);
  if (failed.length > 0) return blocked(failed);

  // 7. Same shape as `expected`.
  return { next_message: message, next_action: nextAction };
}
