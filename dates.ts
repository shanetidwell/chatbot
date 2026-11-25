// Date logic: send_at from last_interaction + the "_dayN" suffix, and loose move timing.

import type { TestCase } from "./types.ts";

// ---------------------------------------------------------------------------
// 2. send_at: N days after last_interaction (in the user's timezone).
//    day0 -> next morning at 09:00; dayN -> N days later at 10:00.
// ---------------------------------------------------------------------------

// N from the "_dayN" suffix of task_id.
export function dayOffset(taskId: string): number {
  const match = /_day(\d+)$/.exec(taskId);
  if (!match) throw new Error(`task_id "${taskId}" has no _dayN suffix`);
  return Number(match[1]);
}

// The calendar date ("YYYY-MM-DD") of an instant, as seen in `timeZone`.
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// UTC offset of `timeZone` at `instant`, in minutes (e.g. -360 for CST).
function offsetMinutes(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT-06:00", or "GMT" for UTC
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// ISO-8601 string for a wall-clock date and hour in `timeZone`, e.g. "2025-12-09T10:00:00-06:00".
function zonedTimestamp(date: string, hour: number, timeZone: string): string {
  const wallClockAsUtc = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  // Look up the offset at the real instant (handles DST: one correction pass is enough).
  let offset = offsetMinutes(new Date(wallClockAsUtc), timeZone);
  offset = offsetMinutes(new Date(wallClockAsUtc - offset * 60_000), timeZone);
  return `${date}T${String(hour).padStart(2, "0")}:00:00${formatOffset(offset)}`;
}

export function computeSendAt(testCase: TestCase): string {
  const { last_interaction, timezone } = testCase.input;
  const n = dayOffset(testCase.task_id);
  const lastDate = localDate(new Date(last_interaction), timezone);
  return n === 0
    ? zonedTimestamp(addDays(lastDate, 1), 9, timezone)
    : zonedTimestamp(addDays(lastDate, n), 10, timezone);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2026-02-15" -> "mid‑February". Loose timing only; the exact date is never shown.
// (Uses a non-breaking hyphen and curly apostrophes to match the brand copy in the samples.)
export function looseMoveTiming(moveDate: string): string {
  const [, month, day] = moveDate.split("-").map(Number);
  const part = day <= 10 ? "early" : day <= 20 ? "mid" : "late";
  return `${part}‑${MONTHS[month - 1]}`;
}
