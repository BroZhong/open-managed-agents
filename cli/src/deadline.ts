// Node timers clamp values above 2^31-1 to 1 ms. Preserve long user deadlines.
export function deadline(milliseconds: number, reason: unknown) {
  const controller = new AbortController();
  const end = performance.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const remaining = end - performance.now();
    if (remaining <= 0) {
      controller.abort(reason);
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2 ** 31 - 1));
    timer.unref();
  };
  if (milliseconds > 0) schedule();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
