// Run: npx tsx chatbot
//
// Subject and body come from OpenAI when OPENAI_API_KEY is set, in the shell or .env (see llm.ts), so they will
// usually differ from `expected` in wording. That doesn't fail the record (the message has already
// passed the brand, Fair Housing and PII checks); the expected and actual text are printed one
// above the other instead. Everything else (channel, send_at, cta, next_action) must match exactly.
//
// Colors: input = cyan, output = green (matches expected) or red (mismatch); differing
// subject/body = yellow.
// Set NO_COLOR=1 to turn colors off.

import { logForObservability } from "./observability.ts";
import { processInput } from "./processInput.ts";
import { readTestCases } from "./testCases.ts";

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

type Difference = { path: string; expected: unknown; actual: unknown };

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // OPENAI_API_KEY etc. from .env, so `npx tsx chatbot` is enough. Variables already set in the
  // shell win. No .env file: carry on, and llm.ts logs that it fell back to the templates.
  try {
    process.loadEnvFile(new URL("./.env", import.meta.url));
  } catch {}
  const testCases = await readTestCases(new URL("./sample.jsonl", import.meta.url));
  let passed = 0;

  for (const testCase of testCases) {
    const { expected, ...input } = testCase;
    console.log(bold(magenta(`\n=== ${testCase.task_id} ===`)));
    console.log(cyan(bold("input:")));
    console.log(cyan(json(input)));

    try {
      const result = await processInput(testCase);
      const differences = diff(expected, result);
      const strict = differences.filter((d) => !TEXT_FIELDS.includes(d.path));
      const wording = differences.filter((d) => TEXT_FIELDS.includes(d.path));
      const matches = strict.length === 0;
      const color = matches ? green : red;

      console.log(color(bold("output:")));
      console.log(color(json(result)));
      if (result.next_message && expected.next_message) printTextComparison(differences);

      if (matches) {
        passed++;
        console.log(bold(green(wording.length ? "✔ MATCH (wording differs)" : "✔ MATCH")));
      } else {
        console.log(bold(red("✘ MISMATCH")));
        for (const d of strict) console.log(red(`  ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`));
        // Paths only: the values can hold message text, so leave them to the console output above.
        logForObservability(testCase.task_id, "output_mismatch", {
          mismatched_fields: strict.map((d) => d.path),
        });
      }
    } catch (err) {
      logForObservability(testCase.task_id, "processing_error", { error: (err as Error).message });
      console.log(bold(red("✘ ERROR")));
      console.log(red((err as Error).stack ?? String(err)));
    }
  }

  const summary = `\n${passed}/${testCases.length} matched`;
  console.log(bold(passed === testCases.length ? green(summary) : red(summary)));
}

main();
