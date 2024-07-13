export function calculateDuration(start: number, end: number): string {
  const durationMs = end - start;
  const durationSeconds = (durationMs / 1000).toFixed(2);
  return durationSeconds + "s";
}
