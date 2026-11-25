// Run: npx tsx chatbot

import { pathToFileURL } from "node:url";
import { buildCta, buildNextAction, pickChannel } from "./actions.ts";
import { blocked, runChecks } from "./checks.ts";
import { computeSendAt } from "./dates.ts";
import { buildBody, buildSubject, finishBody } from "./message.ts";
import { readTestCases } from "./testCases.ts";
import type { NextMessage, ProcessResult, TestCase } from "./types.ts";

// ---------------------------------------------------------------------------
// processInput: the spec's steps, in the order it lists them.
// ---------------------------------------------------------------------------

export function processInput(testCase: TestCase): ProcessResult {
  // 1. Channel. No consented channel means nothing can be sent yet.
  const channel = pickChannel(testCase);
  if (!channel) return blocked(["consent_verified"]);
  if (channel === "voice") throw new Error("Voice messages are not supported yet");

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

async function main(): Promise<void> {
  const testCases = await readTestCases(new URL("./sample.jsonl", import.meta.url));
  for (const testCase of testCases) {
    console.log(`\n=== ${testCase.task_id} ===`);
    try {
      const result = processInput(testCase);
      const matches = JSON.stringify(result) === JSON.stringify(testCase.expected);
      console.log("actual:  ", JSON.stringify(result, null, 2));
      if (!matches) console.log("expected:", JSON.stringify(testCase.expected, null, 2));
      console.log(matches ? "MATCH" : "MISMATCH");
    } catch (err) {
      console.error("error:   ", (err as Error).message);
    }
  }
}

// Run main() only when this file is executed directly (not when imported, e.g. by a test).
// Compare without the extension: `npx tsx chatbot` leaves argv[1] as ".../chatbot", not ".../chatbot.ts".
const withoutExt = (href: string) => href.replace(/\.[cm]?[jt]s$/, "");
if (process.argv[1] && withoutExt(import.meta.url) === withoutExt(pathToFileURL(process.argv[1]).href)) {
  main();
}
