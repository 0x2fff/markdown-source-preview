export type TextareaShortcutResult = 'native' | 'save' | 'cancel' | 'none';

// On macOS, VS Code delivers editing commands (selectAll/cut/copy/paste/
// undo) through the AppKit responder chain, which does not reach textareas
// inside nested webview frames — the keydown arrives but the default
// action never runs (microsoft/vscode#129178). The DOM APIs below cover
// the same operations, so we perform them ourselves on Mac only.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

// Keys whose default textarea behavior must be preserved on platforms
// where it works. We only stop propagation so parent handlers cannot
// treat them as workbench actions; preventDefault would break native
// editing.
const NATIVE_EDIT_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y']);

function dispatchInput(textarea: HTMLTextAreaElement, inputType: string, data?: string): void {
  textarea.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType,
    data,
  }));
}

function applyMacEditShortcut(event: KeyboardEvent, textarea: HTMLTextAreaElement): void {
  const key = event.key.toLowerCase();
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;

  if (key === 'a' && !event.shiftKey) {
    textarea.setSelectionRange(0, textarea.value.length);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
    return;
  }

  if (key === 'c' || key === 'x') {
    const selected = textarea.value.slice(start, end);
    const clipboard = navigator.clipboard;
    if (!selected || !clipboard) return;
    const write = clipboard.writeText(selected).catch(() => {});
    if (key === 'x') {
      void write.then(() => {
        textarea.setRangeText('', start, end, 'end');
        dispatchInput(textarea, 'deleteByCut');
      });
    }
    return;
  }

  if (key === 'v') {
    const read = navigator.clipboard?.readText();
    if (!read) return;
    void read.then(text => {
      if (!text) return;
      textarea.setRangeText(text, start, end, 'end');
      dispatchInput(textarea, 'insertFromPaste', text);
    }).catch(() => {});
    return;
  }

  // z / y: undo / redo through the editing command, which shares the
  // textarea's native undo stack and fires real input events.
  textarea.ownerDocument.execCommand(key === 'y' || event.shiftKey ? 'redo' : 'undo');
}

export function handleTextareaShortcut(event: KeyboardEvent): TextareaShortcutResult {
  if (event.isComposing || event.key === 'Process') return 'none';

  const modifier = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (modifier && !event.altKey && NATIVE_EDIT_KEYS.has(key)) {
    event.stopPropagation();
    if (IS_MAC) {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement) {
        event.preventDefault();
        applyMacEditShortcut(event, target);
      }
    }
    return 'native';
  }

  if (modifier && !event.altKey && (key === 's' || event.key === 'Enter')) {
    event.preventDefault();
    event.stopPropagation();
    return 'save';
  }

  if (event.key === 'Escape' && !modifier && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    return 'cancel';
  }

  return 'none';
}
