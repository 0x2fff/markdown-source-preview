/**
 * Webview measurement utilities with a uniform console.log format:
 * [MARKDOWN_SOURCE_PREVIEW_PERF] webview event=<name> ms=<t> key=val ...
 */

export const Instrumentation = {
  emit(event: string, ms: number, extra?: Record<string, unknown>): void {
    if (!__MARKDOWN_SOURCE_PREVIEW_LAB__) return;
    const parts = [`[MARKDOWN_SOURCE_PREVIEW_PERF] webview event=${event}`, `ms=${ms.toFixed(1)}`];
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        parts.push(`${k}=${JSON.stringify(v)}`);
      }
    }
    console.log(parts.join(' '));
  },
};

/** Emits the first-contentful-paint timing once available. */
let paintObserver: PerformanceObserver | null = null;

function reportPaintTiming(): void {
  if (!__MARKDOWN_SOURCE_PREVIEW_LAB__ || typeof PerformanceObserver === 'undefined') return;

  paintObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') {
        Instrumentation.emit('fcp', entry.startTime, { entryType: entry.entryType });
        paintObserver?.disconnect();
        paintObserver = null;
      }
    }
  });
  try {
    paintObserver.observe({ type: 'paint', buffered: true });
  } catch { /* ignore */ }
}

export function disposeInstrumentation(): void {
  paintObserver?.disconnect();
  paintObserver = null;
}

export function isInstrumentationDisposed(): boolean {
  return paintObserver === null;
}

reportPaintTiming();
