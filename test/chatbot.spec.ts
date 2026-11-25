// Run: npm test   (or: npx tsx --test test/chatbot.spec.ts)
//
// channel, send_at, cta and next_action must match `expected` exactly.
// subject and body only need to match loosely (key content, format, opt-out line, no PII),
// since they will eventually come from a language model.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAIR_HOUSING_PHRASES, runChecks } from "../src/checks.ts";
import { openAIContent, promptInput, RESPONSE_SCHEMA, SYSTEM_PROMPT } from "../src/llm.ts";
import { processInput as processWith } from "../src/processInput.ts";
import { templateContent } from "../src/templates.ts";
import { readTestCases } from "../src/testCases.ts";
import type { ContentGenerator, NextMessage, ProcessResult, TestCase } from "../src/types.ts";
import { longHorizonDay3, longHorizonDay3Es, welcomeDay0, welcomeDay0Es } from "./fixtures.ts";

// The tests use the template generator: deterministic, and no network calls.
const processInput = (testCase: TestCase) => processWith(testCase, templateContent);

// Stands in for the language model: returns the given text as if the model wrote it, so
// non-English messages can be tested without network calls.
function fakeModel(content: { language: string; subject: string | null; body: string }): ContentGenerator {
  return async () => ({ ...content, source: "llm" });
}

// A fake model that replays a record's expected subject and body, in the record's language.
const replayExpected = (testCase: TestCase) =>
  fakeModel({
    language: testCase.input.language,
    subject: testCase.expected.next_message?.subject ?? null,
    body: testCase.expected.next_message?.body ?? "",
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// A copy of `base` with `overrides` deep-merged in (arrays are replaced, not merged).
function variant(base: TestCase, overrides: DeepPartial<TestCase>): TestCase {
  const merge = (target: any, source: any): any => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] = merge(target[key] ?? {}, value);
      } else {
        target[key] = value;
      }
    }
    return target;
  };
  return merge(structuredClone(base), overrides);
}

function sent(result: ProcessResult): NextMessage {
  assert.ok(result.next_message, `expected a message, got next_action ${JSON.stringify(result.next_action)}`);
  return result.next_message;
}

// Everything except subject and body must match exactly.
function assertStructuralMatch(actual: NextMessage, expected: NextMessage): void {
  assert.equal(actual.channel, expected.channel);
  assert.equal(actual.send_at, expected.send_at);
  assert.deepEqual(actual.cta, expected.cta);
}

// Loose content checks shared by every sent message.
function assertCommonContent(message: NextMessage, testCase: TestCase): void {
  const { first_name, city_interest } = testCase.input.profile;
  assert.match(message.body, new RegExp(`^Hi ${first_name}`), "body greets by first name");
  if (city_interest) {
    assert.ok(!message.body.includes(city_interest), "body must not leak city_interest");
    assert.ok(!(message.subject ?? "").includes(city_interest), "subject must not leak city_interest");
  }
  assert.ok(!message.body.includes(testCase.input.move_date_target), "body must not contain the exact move date");
}

// ---------------------------------------------------------------------------
// The two sample cases
// ---------------------------------------------------------------------------

describe("sample: prospect_welcome_day0 (SMS)", async () => {
  const result = await processInput(welcomeDay0);
  const expected = welcomeDay0.expected;

  test("next_action matches exactly", async () => {
    assert.deepEqual(result.next_action, expected.next_action);
  });

  test("channel, send_at and cta match exactly", async () => {
    assertStructuralMatch(sent(result), expected.next_message!);
  });

  test("subject is null for SMS", async () => {
    assert.equal(sent(result).subject, null);
  });

  test("body is a short SMS with reply options and opt-out", async () => {
    const { body } = sent(result);
    assertCommonContent(sent(result), welcomeDay0);
    assert.ok(body.includes("Oak Ridge"), "mentions the property");
    assert.ok(body.includes("Reply 1 for Thu, 2 for Fri"), "has reply options");
    assert.ok(!/https?:\/\//.test(body), "SMS has no link");
    assert.ok(body.endsWith("Reply STOP to opt out."), "ends with SMS opt-out");
    assert.ok(body.length <= 320, "fits in two SMS segments");
  });
});

describe("sample: prospect_long_horizon_day3 (email)", async () => {
  const result = await processInput(longHorizonDay3);
  const expected = longHorizonDay3.expected;

  test("next_action matches exactly", async () => {
    assert.deepEqual(result.next_action, expected.next_action);
  });

  test("channel, send_at and cta match exactly", async () => {
    assertStructuralMatch(sent(result), expected.next_message!);
  });

  test("subject names the property and the amenities", async () => {
    const { subject } = sent(result);
    assert.ok(subject);
    assert.ok(subject.startsWith("Tour Oak Ridge"), subject);
    assert.ok(!subject.includes("Apartments"), "drops 'Apartments'");
    assert.match(subject, /pool/);
    assert.match(subject, /fitness/);
  });

  test("body has the tour link, amenities, loose timing and opt-out", async () => {
    const { body } = sent(result);
    assertCommonContent(sent(result), longHorizonDay3);
    assert.ok(body.includes("https://oakridge.example/tour"), "includes the tour link");
    assert.match(body, /pool/);
    assert.match(body, /fitness/);
    assert.match(body, /February/, "mentions the move month loosely");
    assert.ok(body.endsWith("To opt out of emails, click here or reply STOP."), "ends with email opt-out");
  });
});

// ---------------------------------------------------------------------------
// Channel selection and consent
// ---------------------------------------------------------------------------

describe("channel and consent", async () => {
  test("consent overrides preference: prefers SMS but only opted in to email -> email", async () => {
    const tc = variant(welcomeDay0, { consent: { sms_opt_in: false } });
    const msg = sent(await processInput(tc));
    assert.equal(msg.channel, "email");
    assert.ok(msg.subject?.startsWith("Tour Oak Ridge"));
    assert.deepEqual(msg.cta, { type: "schedule_tour", link: "https://oakridge.example/tour" });
    assert.ok(msg.body.endsWith("To opt out of emails, click here or reply STOP."));
  });

  test("prefers email but only opted in to SMS -> SMS", async () => {
    const tc = variant(longHorizonDay3, { consent: { email_opt_in: false, sms_opt_in: true } });
    const msg = sent(await processInput(tc));
    assert.equal(msg.channel, "sms");
    assert.equal(msg.subject, null);
    assert.equal(msg.cta.link, undefined);
    assert.equal(msg.cta.options?.length, 2);
    assert.ok(msg.body.endsWith("Reply STOP to opt out."));
  });

  test("no consent on any channel -> no message, blocked on consent", async () => {
    const tc = variant(welcomeDay0, { consent: { email_opt_in: false, sms_opt_in: false } });
    assert.deepEqual(await processInput(tc), {
      next_message: null,
      next_action: { type: "resolve_failed_checks", failed_checks: ["consent_verified"] },
    });
  });

  test("consented only to a channel not in preferences -> no message", async () => {
    const tc = variant(welcomeDay0, {
      consent: { email_opt_in: false, sms_opt_in: false, voice_opt_in: true },
      channel_preferences: ["sms", "email"],
    });
    assert.equal((await processInput(tc)).next_message, null);
  });
});

// ---------------------------------------------------------------------------
// Timing (send_at)
// ---------------------------------------------------------------------------

describe("send_at", async () => {
  test("day0 -> next morning at 09:00 local", async () => {
    assert.equal(sent(await processInput(welcomeDay0)).send_at, "2025-12-09T09:00:00-06:00");
  });

  test("dayN -> N days later at 10:00 local", async () => {
    const tc = variant(longHorizonDay3, { task_id: "prospect_long_horizon_day7" });
    assert.equal(sent(await processInput(tc)).send_at, "2025-12-13T10:00:00-06:00");
  });

  test("uses the local date, not the UTC date", async () => {
    // 03:00Z on Dec 7 is still Dec 6 in Chicago -> day3 is Dec 9.
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2025-12-07T03:00:00Z" } });
    assert.equal(sent(await processInput(tc)).send_at, "2025-12-09T10:00:00-06:00");
  });

  test("uses the user's timezone offset", async () => {
    const tc = variant(longHorizonDay3, { input: { timezone: "America/New_York" } });
    assert.equal(sent(await processInput(tc)).send_at, "2025-12-09T10:00:00-05:00");
  });

  test("handles daylight saving time", async () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2026-06-01T15:00:00Z" } });
    assert.equal(sent(await processInput(tc)).send_at, "2026-06-04T10:00:00-05:00");
  });
});

// ---------------------------------------------------------------------------
// next_action
// ---------------------------------------------------------------------------

describe("next_action", async () => {
  test("new -> start_cadence named after the task family", async () => {
    assert.deepEqual((await processInput(welcomeDay0)).next_action, {
      type: "start_cadence",
      name: "prospect_welcome_short_horizon",
    });
  });

  test("open -> follow_up_in_days with N from _dayN", async () => {
    const tc = variant(longHorizonDay3, { task_id: "prospect_long_horizon_day5" });
    assert.deepEqual((await processInput(tc)).next_action, { type: "follow_up_in_days", value: 5 });
  });
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

describe("subject", async () => {
  test("no amenity interests -> just 'Tour <property>'", async () => {
    const tc = structuredClone(longHorizonDay3);
    delete tc.input.profile.amenity_interest;
    assert.equal(sent(await processInput(tc)).subject, "Tour Oak Ridge");
  });

  test("three amenities -> comma list with 'and'", async () => {
    const tc = variant(longHorizonDay3, { input: { profile: { amenity_interest: ["pool", "fitness", "spa"] } } });
    const { subject } = sent(await processInput(tc));
    assert.ok(subject?.includes("pool, fitness, and spa"), subject ?? "");
  });
});

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

describe("opt-out instructions", async () => {
  test("omitted when include_opt_out_instructions is false", async () => {
    const tc = variant(welcomeDay0, { assertions: { constraints: { include_opt_out_instructions: false } } });
    const { body } = sent(await processInput(tc));
    assert.ok(!body.includes("Reply STOP"), body);
  });
});

// ---------------------------------------------------------------------------
// Checks (Fair Housing, brand style, no PII)
// ---------------------------------------------------------------------------

describe("checks", async () => {
  const good = sent(await processInput(welcomeDay0)) as Extract<NextMessage, { channel: "sms" }>;

  test("a generated message passes all checks", async () => {
    assert.deepEqual(runChecks(good, welcomeDay0, "en"), []);
  });

  test("Fair Housing violation is caught", async () => {
    const bad = { ...good, body: good.body.replace("Tours are available", "Perfect for families! Tours are available") };
    assert.deepEqual(runChecks(bad, welcomeDay0, "en"), ["fair_housing_check_passed"]);
  });

  test("missing opt-out fails brand style", async () => {
    const bad = { ...good, body: good.body.replace(" Reply STOP to opt out.", "") };
    assert.ok(runChecks(bad, welcomeDay0, "en").includes("brand_style_applied"));
  });

  test("leaking city_interest fails no_pii_leak", async () => {
    const bad = { ...good, body: good.body.replace("Tours are", "Richardson, TX tours are") };
    assert.ok(runChecks(bad, welcomeDay0, "en").includes("no_pii_leak"));
  });

  test("leaking a phone number fails no_pii_leak", async () => {
    const bad = { ...good, body: good.body.replace("Tours are", "Call 214-555-0123. Tours are") };
    assert.ok(runChecks(bad, welcomeDay0, "en").includes("no_pii_leak"));
  });
});

// ===========================================================================
// MORE SPECS: aimed at finding mistakes in the logic.
//
// Tests under "fixed bugs" each reproduce a bug that was found and fixed;
// they stay as regression tests. Tests marked `todo` are open spec
// questions: they run and report, but don't fail the suite.
// ===========================================================================


const sampleUrl = new URL("../data/sample.jsonl", import.meta.url);

// ---------------------------------------------------------------------------
// sample.jsonl end to end
// ---------------------------------------------------------------------------

describe("sample.jsonl", async () => {
  const records = await readTestCases(sampleUrl);

  test("has the four records, identical to the typed copies in fixtures.ts", async () => {
    assert.deepEqual(records, [welcomeDay0, longHorizonDay3, welcomeDay0Es, longHorizonDay3Es]);
  });

  for (const record of records) {
    // Templates are English only; other languages need the (here: fake) model.
    const generate = record.input.language === "en" ? templateContent : replayExpected(record);
    test(`${record.task_id} (${record.input.language}): everything but subject/body matches expected`, async () => {
      const result = await processWith(record, generate);
      assert.deepEqual(result.next_action, record.expected.next_action);
      assert.equal(result.next_message === null, record.expected.next_message === null);
      if (record.expected.next_message) assertStructuralMatch(sent(result), record.expected.next_message);
    });
  }
});

// ---------------------------------------------------------------------------
// More send_at edge cases
// ---------------------------------------------------------------------------

describe("send_at edge cases", async () => {
  test("day0 late at night local (already the next day in UTC) -> next local morning", async () => {
    // 04:00Z Dec 9 = 22:00 Dec 8 in Chicago -> send Dec 9 09:00.
    const tc = variant(welcomeDay0, { input: { last_interaction: "2025-12-09T04:00:00Z" } });
    assert.equal(sent(await processInput(tc)).send_at, "2025-12-09T09:00:00-06:00");
  });

  test("crosses the year boundary", async () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2025-12-30T18:00:00Z" } });
    assert.equal(sent(await processInput(tc)).send_at, "2026-01-02T10:00:00-06:00");
  });

  test("crosses Feb 29 in a leap year", async () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2028-02-27T18:00:00Z" } });
    assert.equal(sent(await processInput(tc)).send_at, "2028-03-01T10:00:00-06:00");
  });

  test("spring forward between last_interaction and send (CST -> CDT)", async () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2026-03-06T18:00:00Z" } });
    assert.equal(sent(await processInput(tc)).send_at, "2026-03-09T10:00:00-05:00");
  });

  test("fall back between last_interaction and send (CDT -> CST)", async () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2026-10-30T18:00:00Z" } });
    assert.equal(sent(await processInput(tc)).send_at, "2026-11-02T10:00:00-06:00");
  });

  test("half-hour offset timezone", async () => {
    const tc = variant(longHorizonDay3, { input: { timezone: "Asia/Kolkata" } });
    assert.equal(sent(await processInput(tc)).send_at, "2025-12-09T10:00:00+05:30");
  });

  test("UTC timezone gets +00:00", async () => {
    const tc = variant(longHorizonDay3, { input: { timezone: "UTC" } });
    assert.equal(sent(await processInput(tc)).send_at, "2025-12-09T10:00:00+00:00");
  });

  test("multi-digit day suffix", async () => {
    const tc = variant(longHorizonDay3, { task_id: "prospect_long_horizon_day14" });
    const result = await processInput(tc);
    assert.equal(sent(result).send_at, "2025-12-20T10:00:00-06:00");
    assert.deepEqual(result.next_action, { type: "follow_up_in_days", value: 14 });
  });
});

// ---------------------------------------------------------------------------
// Invariants across many generated inputs
// ---------------------------------------------------------------------------

// Local wall-clock parts of an instant in a timezone.
function localParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

describe("invariants", async () => {
  const timezones = ["America/Chicago", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "UTC", "Pacific/Auckland"];
  const days = [0, 1, 3, 7, 14];
  const lastInteractions = ["2025-12-08T15:04:00Z", "2025-12-09T05:30:00Z", "2026-03-07T12:00:00Z", "2026-07-01T23:59:00Z"];
  const amenitySets: string[][] = [[], ["pool"], ["pool", "fitness"], ["pool", "fitness", "spa"]];

  for (const timezone of timezones) {
    for (const channel of ["sms", "email"] as const) {
      test(`${timezone} / ${channel}: every combination sends a well-formed message`, async () => {
        for (const n of days) {
          for (const last_interaction of lastInteractions) {
            for (const amenity_interest of amenitySets) {
              const tc = variant(longHorizonDay3, {
                task_id: `prospect_long_horizon_day${n}`,
                consent: { email_opt_in: channel === "email", sms_opt_in: channel === "sms" },
                input: { timezone, last_interaction, profile: { amenity_interest } },
              });
              const where = `day${n} ${last_interaction} [${amenity_interest}]`;
              const msg = sent(await processInput(tc));

              assert.equal(msg.channel, channel, where);
              assert.deepEqual(runChecks(msg, tc, "en"), [], where);

              // send_at: right local date and hour, and the stated offset is the real one.
              const instant = new Date(msg.send_at);
              assert.ok(!Number.isNaN(instant.getTime()), `${where}: send_at parses`);
              assert.ok(instant > new Date(last_interaction), `${where}: send_at is after last_interaction`);
              const local = localParts(instant, timezone);
              assert.equal(local.hour, n === 0 ? 9 : 10, `${where}: local hour`);
              assert.equal(local.date, msg.send_at.slice(0, 10), `${where}: offset in send_at matches ${timezone}`);
              const lastLocal = localParts(new Date(last_interaction), timezone).date;
              assert.equal(daysBetween(lastLocal, local.date), n === 0 ? 1 : n, `${where}: day offset`);

              // Channel format.
              if (msg.channel === "sms") {
                assert.equal(msg.subject, null, where);
                assert.equal(msg.cta.link, undefined, where);
                assert.equal(msg.cta.options?.length, 2, where);
                for (const o of msg.cta.options!) assert.ok(["Mon", "Tue", "Wed", "Thu", "Fri"].includes(o), `${where}: ${o} is a weekday`);
              } else {
                assert.ok(msg.subject && msg.subject.length > 0, where);
                assert.ok(msg.cta.link && msg.body.includes(msg.cta.link), where);
                assert.equal(msg.cta.options, undefined, where);
              }
            }
          }
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Fixed bugs: regression tests for bugs these specs found.
// ---------------------------------------------------------------------------

describe("fixed bugs", async () => {
  // --- Fair Housing false positives: a single word anywhere blocks the whole message. ---

  test("first name 'Christian' is not a Fair Housing violation", async () => {
    const tc = variant(welcomeDay0, { input: { profile: { first_name: "Christian" } } });
    assert.ok((await processInput(tc)).next_message, "message was blocked");
  });

  test("property 'White Oak Apartments' is not a Fair Housing violation", async () => {
    const tc = variant(welcomeDay0, { input: { property_name: "White Oak Apartments" } });
    assert.ok((await processInput(tc)).next_message, "message was blocked");
  });

  test("describing accessibility features is allowed by Fair Housing", async () => {
    const good = sent(await processInput(welcomeDay0));
    const msg = { ...good, body: good.body.replace("Tours are available", "Wheelchair-accessible units available. Tours are available") };
    assert.deepEqual(runChecks(msg, welcomeDay0, "en"), []);
  });

  // --- Property name shortening. ---

  test("'Apartments' is only dropped as a trailing word ('The Apartments at Legacy' stays readable)", async () => {
    const tc = variant(longHorizonDay3, { input: { property_name: "The Apartments at Legacy", profile: { amenity_interest: [] } } });
    const msg = sent(await processInput(tc));
    assert.ok(!msg.subject?.includes("The at Legacy"), msg.subject ?? "");
    assert.ok(!msg.body.includes("theatlegacy"), msg.body);
  });

  test("a property named just 'Apartments' doesn't produce an empty name or link", async () => {
    const tc = variant(longHorizonDay3, { input: { property_name: "Apartments" } });
    const msg = sent(await processInput(tc));
    assert.ok(!msg.subject?.startsWith("Tour —"), msg.subject ?? "");
    assert.ok(!msg.cta.link?.includes("//.example"), msg.cta.link ?? "");
  });

  // --- SMS tour days vs. "this week". ---

  test("SMS doesn't say 'this week' when the offered days are next week", async () => {
    // day0 after a Thursday interaction -> send Fri Dec 12 -> options Mon/Tue of the following week.
    const tc = variant(welcomeDay0, { input: { last_interaction: "2025-12-11T15:00:00Z" } });
    const msg = sent(await processInput(tc));
    assert.deepEqual(msg.cta.options, ["Mon", "Tue"]);
    assert.ok(!msg.body.includes("this week"), msg.body);
  });

  // --- No-PII check. ---

  test("an empty profile field doesn't make every message fail no_pii_leak", async () => {
    const tc = variant(welcomeDay0, { input: { profile: { city_interest: "" } } });
    assert.ok((await processInput(tc)).next_message, JSON.stringify((await processInput(tc)).next_action));
  });

  test("a partial city_interest leak ('Richardson' without ', TX') is caught", async () => {
    const good = sent(await processInput(welcomeDay0));
    const msg = { ...good, body: good.body.replace("Tours are", "Richardson tours are") };
    assert.ok(runChecks(msg, welcomeDay0, "en").includes("no_pii_leak"));
  });

  // --- Unsupported channel. ---

  test("voice preferred and consented doesn't crash; falls back to the next consented channel", async () => {
    const tc = variant(welcomeDay0, { consent: { voice_opt_in: true }, channel_preferences: ["voice", "sms"] });
    let result: ProcessResult | undefined;
    await assert.doesNotReject(async () => { result = await processInput(tc); });
    assert.equal(result!.next_message?.channel, "sms");
  });
});

// ---------------------------------------------------------------------------
// The fixes above must not weaken the checks.
// ---------------------------------------------------------------------------

describe("fixes don't weaken the checks", async () => {
  test("a Fair Housing violation is still caught when the user is named Christian", async () => {
    const tc = variant(welcomeDay0, { input: { profile: { first_name: "Christian" } } });
    const good = sent(await processInput(tc));
    const bad = { ...good, body: good.body.replace("Tours are", "Adults only. Tours are") };
    assert.deepEqual(runChecks(bad, tc, "en"), ["fair_housing_check_passed"]);
  });

  test("excluding people with disabilities is still caught", async () => {
    const good = sent(await processInput(welcomeDay0));
    const bad = { ...good, body: good.body.replace("Tours are", "No wheelchairs. Tours are") };
    assert.deepEqual(runChecks(bad, welcomeDay0, "en"), ["fair_housing_check_passed"]);
  });

  test("a full city_interest leak is still caught, in any case", async () => {
    const good = sent(await processInput(welcomeDay0));
    const bad = { ...good, body: good.body.replace("Tours are", "RICHARDSON, TX tours are") };
    assert.ok(runChecks(bad, welcomeDay0, "en").includes("no_pii_leak"));
  });

  test("a word that only contains the city isn't flagged (whole-word match)", async () => {
    const tc = variant(welcomeDay0, { input: { profile: { city_interest: "Plano, TX" } } });
    const good = sent(await processInput(tc));
    const msg = { ...good, body: good.body.replace("Tours are", "Our pianoplanos are tuned. Tours are") };
    assert.deepEqual(runChecks(msg, tc, "en"), []);
  });

  test("a property in the same city as city_interest can still be named", async () => {
    const tc = variant(welcomeDay0, { input: { property_name: "Richardson Apartments" } });
    assert.ok((await processInput(tc)).next_message, JSON.stringify((await processInput(tc)).next_action));
  });

  test("Friday send offers next week's days and says 'next week'", async () => {
    const tc = variant(welcomeDay0, { input: { last_interaction: "2025-12-11T15:00:00Z" } });
    assert.match(sent(await processInput(tc)).body, /available next week/);
  });

  test("Wednesday send offers Fri + Mon and doesn't claim a single week", async () => {
    const tc = variant(welcomeDay0, { input: { last_interaction: "2025-12-09T15:00:00Z" } });
    const msg = sent(await processInput(tc));
    assert.deepEqual(msg.cta.options, ["Fri", "Mon"]);
    assert.ok(!/this week|next week/.test(msg.body), msg.body);
  });

  test("'Oak Ridge Apartments' still shortens to 'Oak Ridge' (spec example)", async () => {
    assert.ok(sent(await processInput(longHorizonDay3)).subject?.startsWith("Tour Oak Ridge—"));
  });

  test("voice-only preference with voice consent sends nothing and doesn't throw", async () => {
    const tc = variant(welcomeDay0, { consent: { voice_opt_in: true }, channel_preferences: ["voice"] });
    assert.equal((await processInput(tc)).next_message, null);
  });
});

// ---------------------------------------------------------------------------
// Spec questions: behavior the spec doesn't pin down. Marked todo.
// ---------------------------------------------------------------------------

describe("spec questions", async () => {
  test("lifecycle 'new' on a dayN>0 task gets a sensible cadence name",
    { todo: "currently 'prospect_long_horizon_short_horizon'" }, async () => {
      const tc = variant(longHorizonDay3, { lifecycle_stage: "new" });
      const action = (await processInput(tc)).next_action;
      assert.ok(!("name" in action && action.name.endsWith("_horizon_short_horizon")), JSON.stringify(action));
    });

  test("lifecycle 'open' on day0 doesn't follow up in 0 days",
    { todo: "currently follow_up_in_days: 0" }, async () => {
      const tc = variant(welcomeDay0, { lifecycle_stage: "open" });
      assert.notDeepEqual((await processInput(tc)).next_action, { type: "follow_up_in_days", value: 0 });
    });

  test("task_id without _dayN is blocked rather than throwing",
    { todo: "currently throws" }, async () => {
      const tc = variant(welcomeDay0, { task_id: "prospect_welcome" });
      await assert.doesNotReject(() => processInput(tc));
    });

  test("unknown required_state blocks rather than throwing",
    { todo: "currently throws 'Unknown required state'" }, async () => {
      const tc = structuredClone(welcomeDay0);
      tc.assertions.required_states.push("legal_review");
      await assert.doesNotReject(() => processInput(tc));
    });
});

// ---------------------------------------------------------------------------
// Language: the model writes in input.language; the checks don't depend on it.
// ---------------------------------------------------------------------------

describe("language", async () => {
  test("Spanish SMS from the model is sent as written", async () => {
    const result = await processWith(welcomeDay0Es, replayExpected(welcomeDay0Es));
    assert.deepEqual(result, welcomeDay0Es.expected);
  });

  test("Spanish email from the model is sent as written (accented property name in the link)", async () => {
    const result = await processWith(longHorizonDay3Es, replayExpected(longHorizonDay3Es));
    assert.deepEqual(result, longHorizonDay3Es.expected);
    assert.equal(sent(result).cta.link, "https://lomasdelrio.example/tour");
  });

  test("model unavailable for a Spanish user -> English template is not sent", async () => {
    // processInput's default generator falls back to templates; the tests' wrapper always uses them.
    assert.deepEqual(await processInput(welcomeDay0Es), {
      next_message: null,
      next_action: { type: "resolve_failed_checks", failed_checks: ["language_matched"] },
    });
  });

  test("model answers in English for a Spanish user -> not sent", async () => {
    const english = fakeModel({ language: "en", subject: null, body: welcomeDay0.expected.next_message!.body.replace("Taylor", "Sofía") });
    const result = await processWith(welcomeDay0Es, english);
    assert.equal(result.next_message, null);
    assert.ok("failed_checks" in result.next_action && result.next_action.failed_checks.includes("language_matched"));
  });

  test("regional codes match their language (es-MX message for an es user, and back)", async () => {
    const tc = variant(welcomeDay0Es, { input: { language: "es-MX" } });
    const body = welcomeDay0Es.expected.next_message!.body;
    assert.ok((await processWith(tc, fakeModel({ language: "es", subject: null, body }))).next_message);
    assert.ok((await processWith(welcomeDay0Es, fakeModel({ language: "es-MX", subject: null, body }))).next_message);
  });

  test("Spanish opt-out must keep the STOP keyword", async () => {
    const good = welcomeDay0Es.expected.next_message!;
    const bad = { ...good, body: good.body.replace("Responde STOP para cancelar.", "Responde BAJA para cancelar.") };
    assert.deepEqual(runChecks(bad, welcomeDay0Es, "es"), ["brand_style_applied"]);
  });

  test("Spanish opt-out must come last", async () => {
    const good = welcomeDay0Es.expected.next_message!;
    const bad = { ...good, body: `${good.body} ¡Hasta pronto!` };
    assert.deepEqual(runChecks(bad, welcomeDay0Es, "es"), ["brand_style_applied"]);
  });

  test("Spanish SMS must number the reply choices", async () => {
    const good = welcomeDay0Es.expected.next_message!;
    const bad = { ...good, body: good.body.replace("Responde 1 para jueves, 2 para viernes. ", "") };
    assert.deepEqual(runChecks(bad, welcomeDay0Es, "es"), ["brand_style_applied"]);
  });

  test("Spanish message must greet by first name (accents included)", async () => {
    const good = welcomeDay0Es.expected.next_message!;
    const bad = { ...good, body: good.body.replace("Hola Sofía,", "Hola,") };
    assert.deepEqual(runChecks(bad, welcomeDay0Es, "es"), ["brand_style_applied"]);
  });

  test("leaking city_interest in Spanish still fails no_pii_leak", async () => {
    const good = welcomeDay0Es.expected.next_message!;
    const bad = { ...good, body: good.body.replace("Hay visitas", "En San Antonio hay visitas") };
    assert.ok(runChecks(bad, welcomeDay0Es, "es").includes("no_pii_leak"));
  });

  test("the model gets facts, not English phrases, plus the language", async () => {
    const sms = promptInput(welcomeDay0Es, {
      channel: "sms",
      send_at: "2025-12-16T09:00:00-06:00",
      cta: { type: "schedule_tour", options: ["Thu", "Fri"] },
    });
    assert.equal(sms.language, "es");
    assert.ok("tour_week" in sms);
    assert.equal(sms.tour_week, "this_week");
    assert.deepEqual(sms.tour_days, ["Thu", "Fri"]);
    assert.deepEqual(sms.move_timing, { part: "early", month: 3 });
    const sent = JSON.stringify(sms);
    assert.ok(!sent.includes("San Antonio"), "no city_interest");
    assert.ok(!sent.includes("2026-03-05"), "no exact move date");
    assert.ok(!/Reply|opt out|Thursday|this week/.test(sent), `no English wording: ${sent}`);
  });
});

// ---------------------------------------------------------------------------
// Fair Housing phrase list: one list for the check and the prompt.
// ---------------------------------------------------------------------------

describe("Fair Housing phrase list", async () => {
  test("every example shown to the model is caught by its own pattern (the two stay in step)", () => {
    for (const { pattern, examples } of FAIR_HOUSING_PHRASES) {
      for (const example of examples) assert.match(example, pattern, `"${example}" not matched by ${pattern}`);
    }
  });

  test("the prompt lists every example and says they are English", () => {
    for (const { examples } of FAIR_HOUSING_PHRASES) {
      for (const example of examples) assert.ok(SYSTEM_PROMPT.includes(`"${example}"`), example);
    }
    assert.match(SYSTEM_PROMPT, /These are in English/);
  });
});

// ---------------------------------------------------------------------------
// Untranslated amenities: detected from a (stubbed) model response.
// ---------------------------------------------------------------------------

describe("untranslated amenity detection", async () => {
  // Calls openAIContent with fetch stubbed to return `reply`, and returns the logged event names.
  async function eventsFor(testCase: TestCase, reply: object): Promise<string> {
    const saved = { fetch: globalThis.fetch, error: console.error, key: process.env.OPENAI_API_KEY };
    const logged: string[] = [];
    process.env.OPENAI_API_KEY = "test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        id: "x", model: "stub", usage: {},
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }],
      }))) as typeof fetch;
    console.error = (line: string) => logged.push(line);
    try {
      await openAIContent(testCase, { channel: "email", send_at: "2025-12-15T10:00:00-06:00", cta: { type: "schedule_tour", link: "https://lomasdelrio.example/tour" } });
    } finally {
      globalThis.fetch = saved.fetch;
      console.error = saved.error;
      if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.key;
    }
    return logged.join("\n");
  }

  const french = variant(longHorizonDay3Es, {
    input: { language: "fr", profile: { amenity_interest: ["playground", "kids club", "senior lounge"] } },
  });

  test("a multi-word English label left in a French message is logged", async () => {
    // The kind of output seen before the amenity_terms step.
    const log = await eventsFor(french, {
      language: "fr",
      amenity_terms: ["playground", "kids club", "senior lounge"],
      subject: "Visite Lomas del Río — Voir les espaces playground, kids club & senior lounge",
      body: "Bonjour Mateo,\nDécouvrez nos espaces playground, kids club et senior lounge.",
    });
    assert.match(log, /untranslated_amenities \{"language":"fr","count":2\}/);
  });

  test("a Spanish subject starting with the English 'Tour' is logged", async () => {
    const log = await eventsFor(longHorizonDay3Es, {
      language: "es",
      amenity_terms: ["piscina", "gimnasio", "spa"],
      tour_verb: "Tour",
      subject: "Tour Lomas del Río — Ver la piscina, el gimnasio y el spa que consultaste",
      body: "Hola Mateo,\nVen a ver la piscina, el gimnasio y el spa.",
    });
    assert.match(log, /untranslated_tour_verb \{"language":"es"\}/);
  });

  test("logs carry no message text, first name or amenity values", async () => {
    const log = await eventsFor(french, {
      language: "fr",
      amenity_terms: ["playground", "kids club", "senior lounge"],
      tour_verb: "Visite",
      subject: "Visite Lomas del Río — Voir les espaces playground, kids club & senior lounge",
      body: "Bonjour Mateo,\nDécouvrez nos espaces playground, kids club et senior lounge.",
    });
    assert.match(log, /llm_generated/);
    for (const value of ["Mateo", "Bonjour", "playground", "kids club", "senior lounge", "Découvrez"]) {
      assert.ok(!log.includes(value), `log contains "${value}":\n${log}`);
    }
  });

  test("a model reply that isn't JSON doesn't put the reply text in the log", async () => {
    const saved = { fetch: globalThis.fetch, error: console.error, key: process.env.OPENAI_API_KEY };
    const logged: string[] = [];
    process.env.OPENAI_API_KEY = "test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "x", model: "stub", choices: [{ message: { content: "Hola Sofía, te damos la bienvenida" } }] }))) as typeof fetch;
    console.error = (line: string) => logged.push(line);
    try {
      await openAIContent(welcomeDay0Es, { channel: "sms", send_at: "2025-12-16T09:00:00-06:00", cta: { type: "schedule_tour", options: ["Thu", "Fri"] } });
    } finally {
      globalThis.fetch = saved.fetch;
      console.error = saved.error;
      if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.key;
    }
    const log = logged.join("\n");
    assert.match(log, /OpenAI returned invalid JSON/);
    assert.ok(!log.includes("Sofía"), log);
  });

  test("translated labels are not logged", async () => {
    const log = await eventsFor(french, {
      language: "fr",
      amenity_terms: ["aire de jeux", "club pour enfants", "salon pour seniors"],
      tour_verb: "Visite",
      subject: "Visite Lomas del Río — Voir l'aire de jeux, le club pour enfants & le salon pour seniors",
      body: "Bonjour Mateo,\nDécouvrez notre aire de jeux, le club pour enfants et le salon pour seniors.",
    });
    assert.ok(!log.includes("untranslated_"), log);
  });
});

describe("response schema", () => {
  // OpenAI strict structured output rejects the whole request (HTTP 400) otherwise.
  test("every property is required (OpenAI strict mode)", () => {
    assert.deepEqual([...RESPONSE_SCHEMA.required].sort(), Object.keys(RESPONSE_SCHEMA.properties).sort());
  });
});
