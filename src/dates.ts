// Date logic: send_at from last_interaction + the "_dayN" suffix, weekdays, and loose move timing.
// Plain dates are "YYYY-MM-DD" strings; they're treated as calendar days, with no time zone.

import type { TestCase } from "./types.ts";

// N from the "_dayN" suffix of task_id ("prospect_long_horizon_day3" -> 3).
export function dayOffset(taskId: string): number {
  const match = /_day(\d+)$/.exec(taskId);
  if (!match) throw new Error(`task_id "${taskId}" has no _dayN suffix`);
  return Number(match[1]);
}

// "2025-12-30" + 3 -> "2026-01-02"
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Weekdays
// ---------------------------------------------------------------------------

// Indexed like Date.getUTCDay(): 0 = Sunday.
export const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// 0 = Sunday ... 6 = Saturday.
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// "Thu" -> "Thursday". Anything unrecognized is returned as is.
export function fullDayName(abbr: string): string {
  const i = WEEKDAY_ABBR.indexOf(abbr);
  return i >= 0 ? WEEKDAY_FULL[i] : abbr;
}

// "this week" / "next week" for tour days offered after the send date (weeks start Monday).
// The days come right after the send date, so a day whose weekday comes later in the week than
// the send day's is in the same week; any other is next week.
export function tourWeekPhrase(sendAt: string, options: string[]): string {
  const mondayFirst = (day: number) => (day === 0 ? 7 : day); // Sunday is the last day of the week
  const sendDay = mondayFirst(weekdayOf(sendAt.slice(0, 10)));
  const sameWeek = options.map((o) => mondayFirst(WEEKDAY_ABBR.indexOf(o)) > sendDay);
  if (sameWeek.every(Boolean)) return "this week";
  if (sameWeek.every((x) => !x)) return "next week";
  return "over the next few days";
}

// ---------------------------------------------------------------------------
// send_at (spec step 2): N days after last_interaction, in the user's timezone.
//   day0 -> next morning at 09:00; dayN -> N days later at 10:00.
// ---------------------------------------------------------------------------

export function computeSendAt(testCase: TestCase): string {
  const { last_interaction, timezone } = testCase.input;
  const n = dayOffset(testCase.task_id);
  const lastDate = localDate(new Date(last_interaction), timezone);
  return n === 0
    ? zonedTimestamp(addDays(lastDate, 1), 9, timezone)
    : zonedTimestamp(addDays(lastDate, n), 10, timezone);
}

// The calendar date ("YYYY-MM-DD") of an instant, as seen in `timeZone`.
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

// ISO-8601 string for a wall-clock date and hour in `timeZone`, e.g. "2025-12-09T10:00:00-06:00".
function zonedTimestamp(date: string, hour: number, timeZone: string): string {
  const time = `${String(hour).padStart(2, "0")}:00:00`;
  const wallClockAsUtc = Date.parse(`${date}T${time}Z`);
  // Look up the offset at the real instant (handles DST: one correction pass is enough).
  let offset = offsetMinutes(new Date(wallClockAsUtc), timeZone);
  offset = offsetMinutes(new Date(wallClockAsUtc - offset * 60_000), timeZone);
  return `${date}T${time}${formatOffset(offset)}`;
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

// -360 -> "-06:00"
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ---------------------------------------------------------------------------
// Move timing
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2026-02-15" -> "mid‑February". Loose timing only; the exact date is never shown.
// (Uses a non-breaking hyphen to match the brand copy in the samples.)
export function looseMoveTiming(moveDate: string): string {
  const [, month, day] = moveDate.split("-").map(Number);
  const part = day <= 10 ? "early" : day <= 20 ? "mid" : "late";
  return `${part}‑${MONTHS[month - 1]}`;
}
