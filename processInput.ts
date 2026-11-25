import { buildCta, buildNextAction, pickChannel } from "./actions.ts";
import { blocked, runChecks } from "./checks.ts";
import { computeSendAt } from "./dates.ts";
import { openAIContent } from "./llm.ts";
import { finishBody, templateContent, type ContentGenerator, type MessageContent } from "./message.ts";
import { logForObservability } from "./observability.ts";
import type { CheckName, Cta, NextMessage, ProcessResult, TestCase } from "./types.ts";

// ---------------------------------------------------------------------------
// processInput: the spec's steps, in the order it lists them.
// `generate` writes the subject and body; OpenAI by default, templates in the tests.
// ---------------------------------------------------------------------------

export async function processInput(
  testCase: TestCase,
  generate: ContentGenerator = openAIContent,
): Promise<ProcessResult> {
  // 1. Channel. No consented (and supported) channel means nothing can be sent yet.
  const channel = pickChannel(testCase);
  if (!channel) {
    logForObservability(testCase.task_id, "send_blocked", { reason: "no_consent", failed_checks: ["consent_verified"] });
    return blocked(["consent_verified"]);
  }

  // 2-4. Timing, CTA, next action.
  const send_at = computeSendAt(testCase);
  const cta = buildCta(testCase, channel, send_at);
  const nextAction = buildNextAction(testCase);

  // 5. Content, then 6. checks.
  let { message, failed, source } = await buildAndCheck(testCase, generate, channel, send_at, cta);

  // Model output that fails a check is replaced by the template message, which is checked again.
  if (failed.length > 0 && source === "llm") {
    logForObservability(testCase.task_id, "llm_content_rejected", { failed_checks: failed });
    ({ message, failed, source } = await buildAndCheck(testCase, templateContent, channel, send_at, cta));
  }

  // Any failure: don't send, don't advance.
  if (failed.length > 0) {
    logForObservability(testCase.task_id, "send_blocked", { reason: "failed_checks", failed_checks: failed });
    return blocked(failed);
  }

  // 7. Same shape as `expected`.
  logForObservability(testCase.task_id, "message_ready", { channel, next_action: nextAction.type });
  return { next_message: message, next_action: nextAction };
}

async function buildAndCheck(
  testCase: TestCase,
  generate: ContentGenerator,
  channel: "sms" | "email",
  send_at: string,
  cta: Cta,
): Promise<{ message: NextMessage; failed: CheckName[]; source: MessageContent["source"] }> {
  const content = await generate(testCase, { channel, send_at, cta });
  const body = finishBody(content.body, testCase, channel);
  const message: NextMessage =
    channel === "email"
      ? { channel, send_at, subject: content.subject ?? "", body, cta }
      : { channel, send_at, subject: null, body, cta };

  logForObservability(testCase.task_id, "message_built", {
    channel,
    send_at,
    timezone: testCase.input.timezone,
    generator: content.source,
    body_length: body.length,
    // SMS has a 320-character limit; track headroom so we see it shrinking before it fails.
    ...(channel === "sms" && { sms_length_headroom: 320 - body.length }),
  });

  return { message, failed: runChecks(message, testCase), source: content.source };
}
