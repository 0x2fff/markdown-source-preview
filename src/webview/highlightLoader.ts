/** Shared lazy loader for highlight.js/lib/common. */

export interface HighlightApi {
  highlightElement(el: HTMLElement): void;
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals: boolean },
  ): { value: string };
}

let _hljsPromise: Promise<HighlightApi> | null = null;

export function loadHljs(): Promise<HighlightApi> {
  _hljsPromise ??= import('highlight.js/lib/common').then(
    module => module.default as HighlightApi,
  );
  return _hljsPromise;
}
