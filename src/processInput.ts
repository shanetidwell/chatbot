// processInput: one test case in, `{ next_message, next_action }` out, following the spec's
// steps in the order it lists them. Each step lives in its own module:
//
//   1. channel      channel.ts
//   2. send_at      dates.ts
//   3. CTA          actions.ts
//   4. next_action  actions.ts
//   5. content      llm.ts (OpenAI), templates.ts (fallback)
//   6. checks       checks.ts
//
// `generate` writes the subject and body: OpenAI by default, templates in the tests.

import { buildCta, buildNextAction } from "./actions.ts";
import { pickChannel } from "./channel.ts";
import { runChecks } from "./checks.ts";
import { computeSendAt } from "./dates.ts";
import { openAIContent } from "./llm.ts";
import { logForObservability } from "./observability.ts";
import { templateContent } from "./templates.ts";
import { appendOptOut, SMS_MAX_LENGTH } from "./text.ts";
import type {
  BlockedAction,
  CheckName,
  ContentContext,
  ContentGenerator,
  MessageContent,
  NextMessage,
  ProcessResult,
  TestCase,
} from "./types.ts";

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
  const ctx: ContentContext = { channel, send_at, cta };

  // 5. Content, then 6. checks.
  let { message, failed, source } = await buildAndCheck(testCase, generate, ctx);

  // Model output that fails a check is replaced by the template message, which is checked again.
  if (failed.length > 0 && source === "llm") {
    logForObservability(testCase.task_id, "llm_content_rejected", { failed_checks: failed });
    ({ message, failed, source } = await buildAndCheck(testCase, templateContent, ctx));
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

// Generates the content, assembles the full message (adding the opt-out line), and runs the checks.
async function buildAndCheck(
  testCase: TestCase,
  generate: ContentGenerator,
  ctx: ContentContext,
): Promise<{ message: NextMessage; failed: CheckName[]; source: MessageContent["source"] }> {
  const { channel, send_at, cta } = ctx;
  const content = await generate(testCase, ctx);
  const body = appendOptOut(content.body, testCase, channel);
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
    // Track SMS headroom so we see it shrinking before it fails the length check.
    ...(channel === "sms" && { sms_length_headroom: SMS_MAX_LENGTH - body.length }),
  });

  return { message, failed: runChecks(message, testCase), source: content.source };
}

// Not sending: the next step is to fix what failed (get consent, pass Fair Housing, apply brand
// style, remove PII) instead of advancing.
function blocked(failed: CheckName[]): ProcessResult {
  const next_action: BlockedAction = { type: "resolve_failed_checks", failed_checks: failed };
  return { next_message: null, next_action };
}
