export type TextareaShortcutResult = 'native' | 'save' | 'cancel' | 'none';

// Keys whose default textarea behavior (undo, clipboard, select-all) must
// be preserved. We only stop propagation so parent handlers cannot treat
// them as workbench actions; preventDefault would break native editing.
const NATIVE_EDIT_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y']);

export function handleTextareaShortcut(event: KeyboardEvent): TextareaShortcutResult {
  if (event.isComposing || event.key === 'Process') return 'none';

  const modifier = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (modifier && !event.altKey && NATIVE_EDIT_KEYS.has(key)) {
    event.stopPropagation();
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
