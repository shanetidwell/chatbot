# chatbot

A context-aware message-sending bot. For each record in `data/sample.jsonl` it decides whether to
send, on which channel, when, and what to say, then compares the result with the record's
`expected` block. See [SPEC.md](SPEC.md) for the requirements.

## Running

```sh
npm install
npm start          # run every sample record and compare with `expected`
npm test           # unit tests (template content, no network calls)
npm run typecheck
```

Message text comes from OpenAI when `OPENAI_API_KEY` is set, in the shell or in `.env` at the
repo root. Without it, the deterministic templates are used. Structured logs go to stderr.

## Layout

```
data/sample.jsonl        input records (one test case per line)
src/
  chatbot.ts             runner: reads the samples, prints results and diffs
  processInput.ts        the pipeline: one record in, { next_message, next_action } out
  channel.ts             1. pick the channel from consent and preferences
  dates.ts               2. send_at, weekdays, loose move timing
  actions.ts             3-4. call to action and next action
  llm.ts                 5. subject and body from OpenAI (falls back to templates)
  templates.ts           5. deterministic subject and body
  text.ts                wording rules shared by templates, the LLM prompt and the checks
  checks.ts              6. consent, Fair Housing, brand style and no-PII checks
  types.ts               input and output types
  testCases.ts           JSONL loader
  observability.ts       structured logging
test/
  chatbot.spec.ts        tests
  fixtures.ts            the sample records as typed objects
```
