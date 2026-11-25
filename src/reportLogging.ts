// Console output for chatbot.ts: colors, the expected-vs-actual diff, and the per-record report.
//
// Colors: input = cyan, output = green (matches expected) or red (mismatch), differing
// subject/body = yellow. Set NO_COLOR=1 to turn colors off.

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const bold = paint("1");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const magenta = paint("35");
const dim = paint("2");
const cyan = paint("36");

const json = (value: unknown) => JSON.stringify(value, null, 2);

// ---------------------------------------------------------------------------
// Diff: every leaf path where actual and expected differ.
// ---------------------------------------------------------------------------

export type Difference = { path: string; expected: unknown; actual: unknown };

function diff(expected: unknown, actual: unknown, path = ""): Difference[] {
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
  if (isObject(expected) && isObject(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((key) => diff(expected[key], actual[key], path ? `${path}.${key}` : key));
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [{ path: path || "(root)", expected, actual }];
}

// Fields written by the language model: compared for display, not for pass/fail.
const TEXT_FIELDS = ["next_message.subject", "next_message.body"];

export type Comparison = {
  /** Every differing leaf path. */
  differences: Difference[];
  /** Differences that fail the record (everything except the LLM-written text). */
  strict: Difference[];
  /** Differences in the LLM-written subject/body only. */
  wording: Difference[];
  matches: boolean;
};

export function compare(expected: unknown, actual: unknown): Comparison {
  const differences = diff(expected, actual);
  const strict = differences.filter((d) => !TEXT_FIELDS.includes(d.path));
  const wording = differences.filter((d) => TEXT_FIELDS.includes(d.path));
  return { differences, strict, wording, matches: strict.length === 0 };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

// Multi-line text, indented under its label.
const indent = (text: unknown) => String(text).split("\n").join("\n    ");

function printTextComparison(differences: Difference[]): void {
  console.log(bold("subject / body vs expected:"));
  for (const field of TEXT_FIELDS) {
    const name = field.split(".").pop();
    const d = differences.find((x) => x.path === field);
    if (!d) {
      console.log(green(`  ${name}: same as expected`));
      continue;
    }
    console.log(yellow(`  ${name}: wording differs`));
    console.log(dim("    expected:"));
    console.log(`    ${indent(d.expected)}`);
    console.log(dim("    actual:"));
    console.log(yellow(`    ${indent(d.actual)}`));
  }
}

export function printInput(taskId: string, input: unknown): void {
  console.log(bold(magenta(`\n=== ${taskId} ===`)));
  console.log(cyan(bold("input:")));
  console.log(cyan(json(input)));
}

export function printResult(
  result: { next_message?: unknown },
  expected: { next_message?: unknown },
  comparison: Comparison,
): void {
  const { differences, strict, wording, matches } = comparison;
  const color = matches ? green : red;

  console.log(color(bold("output:")));
  console.log(color(json(result)));
  if (result.next_message && expected.next_message) printTextComparison(differences);

  if (matches) {
    console.log(bold(green(wording.length ? "✔ MATCH (wording differs)" : "✔ MATCH")));
  } else {
    console.log(bold(red("✘ MISMATCH")));
    for (const d of strict) console.log(red(`  ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`));
  }
}

export function printError(err: Error): void {
  console.log(bold(red("✘ ERROR")));
  console.log(red(err.stack ?? String(err)));
}

export function printSummary(passed: number, total: number): void {
  const summary = `\n${passed}/${total} matched`;
  console.log(bold(passed === total ? green(summary) : red(summary)));
}
