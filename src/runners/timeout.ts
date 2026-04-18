export function isTimedOut(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "timedOut" in error && (error as { timedOut: boolean }).timedOut === true;
}

export function isExecaTimedOut(result: { timedOut?: boolean }): boolean {
  return result.timedOut === true;
}
