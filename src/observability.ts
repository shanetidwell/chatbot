// Observability: one structured line per event, prefixed with a timestamp and the task_id so every
// line for a single record can be tied together.
//
// Written to stderr so it never mixes with the runner's stdout output.
// Never pass raw PII in `data`: log categories and pattern names, not matched values.

export function logForObservability(taskId: string, event: string, data: Record<string, unknown> = {}): void {
  console.error(`${new Date().toISOString()} [${taskId}] ${event} ${JSON.stringify(data)}`);
}
