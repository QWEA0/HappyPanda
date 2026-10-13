// Set HAPPYPANDA_PERF=1 to log how long slow-path operations take.
const enabled = process.env.HAPPYPANDA_PERF === '1';

export async function timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
  if (!enabled) return operation();
  const start = performance.now();
  try { return await operation(); }
  finally { console.error(`[perf] ${(performance.now() - start).toFixed(0).padStart(6)}ms ${label}`); }
}
