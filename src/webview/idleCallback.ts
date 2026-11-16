/**
 * requestIdleCallback helpers with a timer fallback for webviews that do
 * not expose the API.
 */

export function requestIdleCallback(
  callback: IdleRequestCallback,
  options?: IdleRequestOptions,
): number {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(callback, options);
  }
  return window.setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 10 }),
    Math.min(16, options?.timeout ?? 16),
  );
}

export function cancelIdleCallback(handle: number): void {
  if (typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle);
  } else {
    clearTimeout(handle);
  }
}
