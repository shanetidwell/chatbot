// Loads test cases from a JSONL file such as data/sample.jsonl.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { TestCase } from "./types.ts";

// Reads a JSONL file (one test case per line) and parses each non-blank line into a TestCase.
export async function readTestCases(path: URL): Promise<TestCase[]> {
  const fileName = basename(path.pathname);
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as TestCase;
      } catch (err) {
        throw new Error(`${fileName} line ${i + 1}: invalid JSON (${(err as Error).message})`);
      }
    });
}
