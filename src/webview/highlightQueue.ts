/**
 * Deferred syntax highlighting.
 *
 * - Code blocks in the initial viewport highlight on the first idle
 *   after DOMContentLoaded.
 * - Off-screen blocks highlight when an IntersectionObserver reports
 *   them visible; the rest warm up via requestIdleCallback.
 * - highlight.js is dynamically imported, off the first-paint path.
 */

import { loadHljs, type HighlightApi } from './highlightLoader.js';
import { cancelIdleCallback, requestIdleCallback } from './idleCallback.js';

const SELECTOR = 'pre code[class*="language-"]';
const VIEWPORT_MARGIN = '1000px'; // IntersectionObserver rootMargin

export class HighlightQueue {
  private _observer: IntersectionObserver | null = null;
  private _mutationObserver: MutationObserver | null = null;
  private _idleHandle: number | null = null;
  private _disposed = false;

  /** Attaches to the root element; clears previous observers on re-attach. */
  attach(root: HTMLElement): void {
    this._disposed = false;
    this._detach();

    const observer = new IntersectionObserver(
      entries => this._onIntersect(entries, observer),
      { rootMargin: VIEWPORT_MARGIN },
    );
    this._observer = observer;

    // observe the currently pending elements
    this._observePending(root, observer);

    // MutationObserver watches for newly added blocks
    this._mutationObserver = new MutationObserver(() => {
      if (this._observer === observer) this._observePending(root, observer);
    });
    this._mutationObserver.observe(root, { childList: true, subtree: true });
  }

  dispose(): void {
    this._disposed = true;
    this._detach();
  }

  get cleanupState(): {
    disposed: boolean;
    observersDisconnected: boolean;
    pendingIdleCallbacks: number;
  } {
    return {
      disposed: this._disposed,
      observersDisconnected: this._observer === null && this._mutationObserver === null,
      pendingIdleCallbacks: this._idleHandle === null ? 0 : 1,
    };
  }

  private _observePending(root: HTMLElement, observer: IntersectionObserver): void {
    const candidates = root.querySelectorAll<HTMLElement>(SELECTOR);
    for (const el of candidates) {
      if (el.dataset.hlState !== 'done') {
        el.dataset.hlState = 'pending';
        observer.observe(el);
      }
    }
  }

  private _onIntersect(entries: IntersectionObserverEntry[], observer: IntersectionObserver): void {
    if (this._observer !== observer) return;
    const hits: HTMLElement[] = [];
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      observer.unobserve(el);
      if (el.dataset.hlState !== 'done') hits.push(el);
    }
    if (hits.length === 0) return;

    loadHljs().then((hljs) => {
      if (this._observer !== observer) return;
      for (const el of hits) {
        this._highlightOne(hljs, el);
      }
      // start background warmup after visible processing finishes
      this._scheduleWarmup();
    });
  }

  private _highlightOne(hljs: HighlightApi, el: HTMLElement): void {
    if (!el.isConnected || el.dataset.hlState === 'done') return;
    try { hljs.highlightElement(el); } catch { /* ignore */ }
    el.dataset.hlState = 'done';
  }

  private _scheduleWarmup(): void {
    if (this._idleHandle !== null) return;
    this._processWarmupStep();
  }

  private _processWarmupStep(): void {
    const observer = this._observer;
    if (!observer) return;
    this._idleHandle = requestIdleCallback(
      (deadline) => {
        this._idleHandle = null;
        loadHljs().then((hljs) => {
          if (this._observer !== observer) return;
          let count = 0;
          const all = document.querySelectorAll<HTMLElement>(SELECTOR);
          for (const el of all) {
            if (el.dataset.hlState === 'done') continue;
            this._highlightOne(hljs, el);
            count++;
            if (deadline.timeRemaining() < 5) break;
          }
          // continue on the next idle if anything remains
          const remaining = document.querySelectorAll<HTMLElement>(`${SELECTOR}:not([data-hl-state="done"])`);
          if (remaining.length > 0) {
            this._processWarmupStep();
          }
        });
      },
      { timeout: 2000 },
    );
  }

  private _detach(): void {
    this._observer?.disconnect();
    this._mutationObserver?.disconnect();
    this._observer = null;
    this._mutationObserver = null;
    if (this._idleHandle !== null) {
      cancelIdleCallback(this._idleHandle);
      this._idleHandle = null;
    }
  }
}
