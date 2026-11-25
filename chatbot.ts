// Run: npx tsx chatbot
//
// Colors: input = cyan, output = green (matches expected) or red (mismatch).
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
const magenta = paint("35");
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const testCases = await readTestCases(new URL("./sample.jsonl", import.meta.url));
  let passed = 0;

  for (const testCase of testCases) {
    const { expected, ...input } = testCase;
    console.log(bold(magenta(`\n=== ${testCase.task_id} ===`)));
    console.log(cyan(bold("input:")));
    console.log(cyan(json(input)));

    try {
      const result = processInput(testCase);
      const differences = diff(expected, result);
      const matches = differences.length === 0;
      const color = matches ? green : red;

      console.log(color(bold("output:")));
      console.log(color(json(result)));

      if (matches) {
        passed++;
        console.log(bold(green("✔ MATCH")));
      } else {
        console.log(bold(red("✘ MISMATCH")));
        // Paths only: the values can hold message text, so leave them to the console output above.
        logForObservability(testCase.task_id, "output_mismatch", {
          mismatched_fields: differences.map((d) => d.path),
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
