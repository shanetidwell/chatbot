// Run: npx tsx --test chatbot.spec.ts
//
// channel, send_at, cta and next_action must match `expected` exactly.
// subject and body only need to match loosely (key content, format, opt-out line, no PII),
// since they will eventually come from a language model.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { processInput } from "./chatbot.ts";
import { runChecks } from "./checks.ts";
import { longHorizonDay3, readTestCases, welcomeDay0 } from "./testCases.ts";
import type { NextMessage, ProcessResult, TestCase } from "./types.ts";

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

describe("sample: prospect_welcome_day0 (SMS)", () => {
  const result = processInput(welcomeDay0);
  const expected = welcomeDay0.expected;

  test("next_action matches exactly", () => {
    assert.deepEqual(result.next_action, expected.next_action);
  });

  test("channel, send_at and cta match exactly", () => {
    assertStructuralMatch(sent(result), expected.next_message!);
  });

  test("subject is null for SMS", () => {
    assert.equal(sent(result).subject, null);
  });

  test("body is a short SMS with reply options and opt-out", () => {
    const { body } = sent(result);
    assertCommonContent(sent(result), welcomeDay0);
    assert.ok(body.includes("Oak Ridge"), "mentions the property");
    assert.ok(body.includes("Reply 1 for Thu, 2 for Fri"), "has reply options");
    assert.ok(!/https?:\/\//.test(body), "SMS has no link");
    assert.ok(body.endsWith("Reply STOP to opt out."), "ends with SMS opt-out");
    assert.ok(body.length <= 320, "fits in two SMS segments");
  });
});

describe("sample: prospect_long_horizon_day3 (email)", () => {
  const result = processInput(longHorizonDay3);
  const expected = longHorizonDay3.expected;

  test("next_action matches exactly", () => {
    assert.deepEqual(result.next_action, expected.next_action);
  });

  test("channel, send_at and cta match exactly", () => {
    assertStructuralMatch(sent(result), expected.next_message!);
  });

  test("subject names the property and the amenities", () => {
    const { subject } = sent(result);
    assert.ok(subject);
    assert.ok(subject.startsWith("Tour Oak Ridge"), subject);
    assert.ok(!subject.includes("Apartments"), "drops 'Apartments'");
    assert.match(subject, /pool/);
    assert.match(subject, /fitness/);
  });

  test("body has the tour link, amenities, loose timing and opt-out", () => {
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

describe("channel and consent", () => {
  test("consent overrides preference: prefers SMS but only opted in to email -> email", () => {
    const tc = variant(welcomeDay0, { consent: { sms_opt_in: false } });
    const msg = sent(processInput(tc));
    assert.equal(msg.channel, "email");
    assert.ok(msg.subject?.startsWith("Tour Oak Ridge"));
    assert.deepEqual(msg.cta, { type: "schedule_tour", link: "https://oakridge.example/tour" });
    assert.ok(msg.body.endsWith("To opt out of emails, click here or reply STOP."));
  });

  test("prefers email but only opted in to SMS -> SMS", () => {
    const tc = variant(longHorizonDay3, { consent: { email_opt_in: false, sms_opt_in: true } });
    const msg = sent(processInput(tc));
    assert.equal(msg.channel, "sms");
    assert.equal(msg.subject, null);
    assert.equal(msg.cta.link, undefined);
    assert.equal(msg.cta.options?.length, 2);
    assert.ok(msg.body.endsWith("Reply STOP to opt out."));
  });

  test("no consent on any channel -> no message, blocked on consent", () => {
    const tc = variant(welcomeDay0, { consent: { email_opt_in: false, sms_opt_in: false } });
    assert.deepEqual(processInput(tc), {
      next_message: null,
      next_action: { type: "resolve_failed_checks", failed_checks: ["consent_verified"] },
    });
  });

  test("consented only to a channel not in preferences -> no message", () => {
    const tc = variant(welcomeDay0, {
      consent: { email_opt_in: false, sms_opt_in: false, voice_opt_in: true },
      channel_preferences: ["sms", "email"],
    });
    assert.equal(processInput(tc).next_message, null);
  });
});

// ---------------------------------------------------------------------------
// Timing (send_at)
// ---------------------------------------------------------------------------

describe("send_at", () => {
  test("day0 -> next morning at 09:00 local", () => {
    assert.equal(sent(processInput(welcomeDay0)).send_at, "2025-12-09T09:00:00-06:00");
  });

  test("dayN -> N days later at 10:00 local", () => {
    const tc = variant(longHorizonDay3, { task_id: "prospect_long_horizon_day7" });
    assert.equal(sent(processInput(tc)).send_at, "2025-12-13T10:00:00-06:00");
  });

  test("uses the local date, not the UTC date", () => {
    // 03:00Z on Dec 7 is still Dec 6 in Chicago -> day3 is Dec 9.
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2025-12-07T03:00:00Z" } });
    assert.equal(sent(processInput(tc)).send_at, "2025-12-09T10:00:00-06:00");
  });

  test("uses the user's timezone offset", () => {
    const tc = variant(longHorizonDay3, { input: { timezone: "America/New_York" } });
    assert.equal(sent(processInput(tc)).send_at, "2025-12-09T10:00:00-05:00");
  });

  test("handles daylight saving time", () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2026-06-01T15:00:00Z" } });
    assert.equal(sent(processInput(tc)).send_at, "2026-06-04T10:00:00-05:00");
  });
});

// ---------------------------------------------------------------------------
// next_action
// ---------------------------------------------------------------------------

describe("next_action", () => {
  test("new -> start_cadence named after the task family", () => {
    assert.deepEqual(processInput(welcomeDay0).next_action, {
      type: "start_cadence",
      name: "prospect_welcome_short_horizon",
    });
  });

  test("open -> follow_up_in_days with N from _dayN", () => {
    const tc = variant(longHorizonDay3, { task_id: "prospect_long_horizon_day5" });
    assert.deepEqual(processInput(tc).next_action, { type: "follow_up_in_days", value: 5 });
  });
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

describe("subject", () => {
  test("no amenity interests -> just 'Tour <property>'", () => {
    const tc = structuredClone(longHorizonDay3);
    delete tc.input.profile.amenity_interest;
    assert.equal(sent(processInput(tc)).subject, "Tour Oak Ridge");
  });

  test("three amenities -> comma list with 'and'", () => {
    const tc = variant(longHorizonDay3, { input: { profile: { amenity_interest: ["pool", "fitness", "spa"] } } });
    const { subject } = sent(processInput(tc));
    assert.ok(subject?.includes("pool, fitness, and spa"), subject ?? "");
  });
});

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

describe("opt-out instructions", () => {
  test("omitted when include_opt_out_instructions is false", () => {
    const tc = variant(welcomeDay0, { assertions: { constraints: { include_opt_out_instructions: false } } });
    const { body } = sent(processInput(tc));
    assert.ok(!body.includes("Reply STOP"), body);
  });
});

// ---------------------------------------------------------------------------
// Checks (Fair Housing, brand style, no PII)
// ---------------------------------------------------------------------------

describe("checks", () => {
  const good = sent(processInput(welcomeDay0)) as Extract<NextMessage, { channel: "sms" }>;

  test("a generated message passes all checks", () => {
    assert.deepEqual(runChecks(good, welcomeDay0), []);
  });

  test("Fair Housing violation is caught", () => {
    const bad = { ...good, body: good.body.replace("Tours are available", "Perfect for families! Tours are available") };
    assert.deepEqual(runChecks(bad, welcomeDay0), ["fair_housing_check_passed"]);
  });

  test("missing opt-out fails brand style", () => {
    const bad = { ...good, body: good.body.replace(" Reply STOP to opt out.", "") };
    assert.ok(runChecks(bad, welcomeDay0).includes("brand_style_applied"));
  });

  test("leaking city_interest fails no_pii_leak", () => {
    const bad = { ...good, body: good.body.replace("Tours are", "Richardson, TX tours are") };
    assert.ok(runChecks(bad, welcomeDay0).includes("no_pii_leak"));
  });

  test("leaking a phone number fails no_pii_leak", () => {
    const bad = { ...good, body: good.body.replace("Tours are", "Call 214-555-0123. Tours are") };
    assert.ok(runChecks(bad, welcomeDay0).includes("no_pii_leak"));
  });
});

// ===========================================================================
// MORE SPECS: aimed at finding mistakes in the logic.
//
// Tests under "known bugs" assert the behavior the spec intends; they FAIL
// against the current code on purpose. Tests marked `todo` are open spec
// questions: they run and report, but don't fail the suite.
// ===========================================================================


const sampleUrl = new URL("./sample.jsonl", import.meta.url);

// ---------------------------------------------------------------------------
// sample.jsonl end to end
// ---------------------------------------------------------------------------

describe("sample.jsonl", async () => {
  const records = await readTestCases(sampleUrl);

  test("has the two records, identical to the typed copies in testCases.ts", () => {
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], welcomeDay0);
    assert.deepEqual(records[1], longHorizonDay3);
  });

  for (const record of records) {
    test(`${record.task_id}: everything but subject/body matches expected`, () => {
      const result = processInput(record);
      assert.deepEqual(result.next_action, record.expected.next_action);
      assert.equal(result.next_message === null, record.expected.next_message === null);
      if (record.expected.next_message) assertStructuralMatch(sent(result), record.expected.next_message);
    });
  }
});

// ---------------------------------------------------------------------------
// More send_at edge cases
// ---------------------------------------------------------------------------

describe("send_at edge cases", () => {
  test("day0 late at night local (already the next day in UTC) -> next local morning", () => {
    // 04:00Z Dec 9 = 22:00 Dec 8 in Chicago -> send Dec 9 09:00.
    const tc = variant(welcomeDay0, { input: { last_interaction: "2025-12-09T04:00:00Z" } });
    assert.equal(sent(processInput(tc)).send_at, "2025-12-09T09:00:00-06:00");
  });

  test("crosses the year boundary", () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2025-12-30T18:00:00Z" } });
    assert.equal(sent(processInput(tc)).send_at, "2026-01-02T10:00:00-06:00");
  });

  test("crosses Feb 29 in a leap year", () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2028-02-27T18:00:00Z" } });
    assert.equal(sent(processInput(tc)).send_at, "2028-03-01T10:00:00-06:00");
  });

  test("spring forward between last_interaction and send (CST -> CDT)", () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2026-03-06T18:00:00Z" } });
    assert.equal(sent(processInput(tc)).send_at, "2026-03-09T10:00:00-05:00");
  });

  test("fall back between last_interaction and send (CDT -> CST)", () => {
    const tc = variant(longHorizonDay3, { input: { last_interaction: "2026-10-30T18:00:00Z" } });
    assert.equal(sent(processInput(tc)).send_at, "2026-11-02T10:00:00-06:00");
  });

  test("half-hour offset timezone", () => {
    const tc = variant(longHorizonDay3, { input: { timezone: "Asia/Kolkata" } });
    assert.equal(sent(processInput(tc)).send_at, "2025-12-09T10:00:00+05:30");
  });

  test("UTC timezone gets +00:00", () => {
    const tc = variant(longHorizonDay3, { input: { timezone: "UTC" } });
    assert.equal(sent(processInput(tc)).send_at, "2025-12-09T10:00:00+00:00");
  });

  test("multi-digit day suffix", () => {
    const tc = variant(longHorizonDay3, { task_id: "prospect_long_horizon_day14" });
    const result = processInput(tc);
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

describe("invariants", () => {
  const timezones = ["America/Chicago", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "UTC", "Pacific/Auckland"];
  const days = [0, 1, 3, 7, 14];
  const lastInteractions = ["2025-12-08T15:04:00Z", "2025-12-09T05:30:00Z", "2026-03-07T12:00:00Z", "2026-07-01T23:59:00Z"];
  const amenitySets: string[][] = [[], ["pool"], ["pool", "fitness"], ["pool", "fitness", "spa"]];

  for (const timezone of timezones) {
    for (const channel of ["sms", "email"] as const) {
      test(`${timezone} / ${channel}: every combination sends a well-formed message`, () => {
        for (const n of days) {
          for (const last_interaction of lastInteractions) {
            for (const amenity_interest of amenitySets) {
              const tc = variant(longHorizonDay3, {
                task_id: `prospect_long_horizon_day${n}`,
                consent: { email_opt_in: channel === "email", sms_opt_in: channel === "sms" },
                input: { timezone, last_interaction, profile: { amenity_interest } },
              });
              const where = `day${n} ${last_interaction} [${amenity_interest}]`;
              const msg = sent(processInput(tc));

              assert.equal(msg.channel, channel, where);
              assert.deepEqual(runChecks(msg, tc), [], where);

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
// Known bugs: these assert intended behavior and currently FAIL.
// ---------------------------------------------------------------------------

describe("known bugs", () => {
  // --- Fair Housing false positives: a single word anywhere blocks the whole message. ---

  test("first name 'Christian' is not a Fair Housing violation", () => {
    const tc = variant(welcomeDay0, { input: { profile: { first_name: "Christian" } } });
    assert.ok(processInput(tc).next_message, "message was blocked");
  });

  test("property 'White Oak Apartments' is not a Fair Housing violation", () => {
    const tc = variant(welcomeDay0, { input: { property_name: "White Oak Apartments" } });
    assert.ok(processInput(tc).next_message, "message was blocked");
  });

  test("describing accessibility features is allowed by Fair Housing", () => {
    const good = sent(processInput(welcomeDay0));
    const msg = { ...good, body: good.body.replace("Tours are available", "Wheelchair-accessible units available. Tours are available") };
    assert.deepEqual(runChecks(msg, welcomeDay0), []);
  });

  // --- Property name shortening. ---

  test("'Apartments' is only dropped as a trailing word ('The Apartments at Legacy' stays readable)", () => {
    const tc = variant(longHorizonDay3, { input: { property_name: "The Apartments at Legacy", profile: { amenity_interest: [] } } });
    const msg = sent(processInput(tc));
    assert.ok(!msg.subject?.includes("The at Legacy"), msg.subject ?? "");
    assert.ok(!msg.body.includes("theatlegacy"), msg.body);
  });

  test("a property named just 'Apartments' doesn't produce an empty name or link", () => {
    const tc = variant(longHorizonDay3, { input: { property_name: "Apartments" } });
    const msg = sent(processInput(tc));
    assert.ok(!msg.subject?.startsWith("Tour —"), msg.subject ?? "");
    assert.ok(!msg.cta.link?.includes("//.example"), msg.cta.link ?? "");
  });

  // --- SMS tour days vs. "this week". ---

  test("SMS doesn't say 'this week' when the offered days are next week", () => {
    // day0 after a Thursday interaction -> send Fri Dec 12 -> options Mon/Tue of the following week.
    const tc = variant(welcomeDay0, { input: { last_interaction: "2025-12-11T15:00:00Z" } });
    const msg = sent(processInput(tc));
    assert.deepEqual(msg.cta.options, ["Mon", "Tue"]);
    assert.ok(!msg.body.includes("this week"), msg.body);
  });

  // --- No-PII check. ---

  test("an empty profile field doesn't make every message fail no_pii_leak", () => {
    const tc = variant(welcomeDay0, { input: { profile: { city_interest: "" } } });
    assert.ok(processInput(tc).next_message, JSON.stringify(processInput(tc).next_action));
  });

  test("a partial city_interest leak ('Richardson' without ', TX') is caught", () => {
    const good = sent(processInput(welcomeDay0));
    const msg = { ...good, body: good.body.replace("Tours are", "Richardson tours are") };
    assert.ok(runChecks(msg, welcomeDay0).includes("no_pii_leak"));
  });

  // --- Unsupported channel. ---

  test("voice preferred and consented doesn't crash; falls back to the next consented channel", () => {
    const tc = variant(welcomeDay0, { consent: { voice_opt_in: true }, channel_preferences: ["voice", "sms"] });
    let result: ProcessResult | undefined;
    assert.doesNotThrow(() => { result = processInput(tc); });
    assert.equal(result!.next_message?.channel, "sms");
  });
});

// ---------------------------------------------------------------------------
// Spec questions: behavior the spec doesn't pin down. Marked todo.
// ---------------------------------------------------------------------------

describe("spec questions", () => {
  test("lifecycle 'new' on a dayN>0 task gets a sensible cadence name",
    { todo: "currently 'prospect_long_horizon_short_horizon'" }, () => {
      const tc = variant(longHorizonDay3, { lifecycle_stage: "new" });
      const action = processInput(tc).next_action;
      assert.ok(!("name" in action && action.name.endsWith("_horizon_short_horizon")), JSON.stringify(action));
    });

  test("lifecycle 'open' on day0 doesn't follow up in 0 days",
    { todo: "currently follow_up_in_days: 0" }, () => {
      const tc = variant(welcomeDay0, { lifecycle_stage: "open" });
      assert.notDeepEqual(processInput(tc).next_action, { type: "follow_up_in_days", value: 0 });
    });

  test("non-English language is not sent in English",
    { todo: "spec says English only for now; code ignores input.language" }, () => {
      const tc = variant(welcomeDay0, { input: { language: "es" } });
      assert.equal(processInput(tc).next_message, null);
    });

  test("task_id without _dayN is blocked rather than throwing",
    { todo: "currently throws" }, () => {
      const tc = variant(welcomeDay0, { task_id: "prospect_welcome" });
      assert.doesNotThrow(() => processInput(tc));
    });

  test("unknown required_state blocks rather than throwing",
    { todo: "currently throws 'Unknown required state'" }, () => {
      const tc = structuredClone(welcomeDay0);
      tc.assertions.required_states.push("legal_review");
      assert.doesNotThrow(() => processInput(tc));
    });
});
