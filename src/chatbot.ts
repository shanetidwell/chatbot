// Runs every record in data/sample.jsonl through processInput and compares it with `expected`.
//
// Run: npm start   (or: npx tsx src/chatbot.ts)
//
// Subject and body come from OpenAI when OPENAI_API_KEY is set, in the shell or .env (see
// llm.ts), so they will usually differ from `expected` in wording. That doesn't fail the record
// (the message has already passed the brand, Fair Housing and PII checks); the expected and
// actual text are printed one above the other instead. Everything else (channel, send_at, cta,
// next_action) must match exactly.
//
// Console formatting (colors, diff) lives in reportLogging.ts.

import { logForObservability } from "./observability.ts";
import { processInput } from "./processInput.ts";
import { compare, printError, printInput, printResult, printSummary } from "./reportLogging.ts";
import { readTestCases } from "./testCases.ts";

async function main(): Promise<void> {
  // OPENAI_API_KEY etc. from .env, so `npm start` is enough. Variables already set in the
  // shell win. No .env file: carry on, and llm.ts logs that it fell back to the templates.
  try {
    process.loadEnvFile(new URL("../.env", import.meta.url));
  } catch {}
  const testCases = await readTestCases(new URL("../data/sample.jsonl", import.meta.url));
  let passed = 0;

  for (const testCase of testCases) {
    const { expected, ...input } = testCase;
    printInput(testCase.task_id, input);

    try {
      const result = await processInput(testCase);
      const comparison = compare(expected, result);
      printResult(result, expected, comparison);

      if (comparison.matches) {
        passed++;
      } else {
        // Paths only: the values can hold message text, so leave them to the console output above.
        logForObservability(testCase.task_id, "output_mismatch", {
          mismatched_fields: comparison.strict.map((d) => d.path),
        });
      }
    } catch (err) {
      logForObservability(testCase.task_id, "processing_error", { error: (err as Error).message });
      printError(err as Error);
    }
  }

  printSummary(passed, testCases.length);
}

main();
