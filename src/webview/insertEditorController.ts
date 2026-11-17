import type { BlockStore } from './blockStore.js';
import type { WebviewToHost } from '../core/renderModel.js';
import { handleTextareaShortcut } from './textareaShortcuts.js';

type EditMode = 'read' | 'edit' | 'readonly';

interface InsertAnchor {
  beforeBlockId?: string;
  afterBlockId?: string;
}

interface ActiveInsertEditor extends InsertAnchor {
  element: HTMLElement;
  textarea: HTMLTextAreaElement;
}

export class InsertEditorController {
  private mode: EditMode = 'read';
  private active: ActiveInsertEditor | undefined;
  private marker: HTMLElement | undefined;
  private markerAnchor: InsertAnchor | undefined;
  private emptyEditor: HTMLElement | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly blocks: BlockStore,
    private readonly post: (message: WebviewToHost) => void,
    private readonly isBlockEditing: () => boolean,
    signal: AbortSignal,
  ) {
    root.addEventListener('pointermove', event => {
      if (this.mode !== 'edit' || this.isBlockEditing() || this.active) {
        this.hideMarker();
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-block-id]')) {
        this.hideMarker();
        return;
      }
      this.updateMarker(event.clientY);
    }, { passive: true, signal });

    root.addEventListener('pointerleave', event => {
      const related = event.relatedTarget;
      if (related instanceof Element && related.closest('.markdown-source-preview-insert-point')) return;
      this.hideMarker();
    }, { signal });

    document.addEventListener('scroll', () => this.hideMarker(), {
      capture: true,
      passive: true,
      signal,
    });
    window.addEventListener('resize', () => this.hideMarker(), { signal });
  }

  setMode(mode: EditMode): void {
    if (mode !== 'edit' && this.active) this.commit(true);
    this.mode = mode;
    this.hideMarker();
    this.syncEmptyEditor();
  }

  dispose(): void {
    this.active?.element.remove();
    this.active = undefined;
    this.marker?.remove();
    this.marker = undefined;
    this.markerAnchor = undefined;
    this.emptyEditor?.remove();
    this.emptyEditor = undefined;
  }

  hideMarker(): void {
    this.markerAnchor = undefined;
    if (this.marker) this.marker.hidden = true;
  }

  syncEmptyEditor(): void {
    const show = this.mode === 'edit'
      && !this.active
      && !this.isBlockEditing()
      && this.root.querySelector(':scope > [data-block-id]') === null;
    if (show && !this.emptyEditor) {
      const element = document.createElement('div');
      element.className = 'markdown-source-preview-empty-editor';
      element.textContent = 'Click to start writing Markdown';
      element.addEventListener('click', () => this.open({}));
      this.root.appendChild(element);
      this.emptyEditor = element;
    } else if (!show && this.emptyEditor) {
      this.emptyEditor.remove();
      this.emptyEditor = undefined;
    }
  }

  private ensureMarker(): HTMLElement {
    if (this.marker) return this.marker;
    const marker = document.createElement('div');
    marker.className = 'markdown-source-preview-insert-point';
    marker.hidden = true;
    marker.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const anchor = this.gapAt(event.clientY)?.anchor ?? this.markerAnchor;
      this.hideMarker();
      if (anchor) this.open(anchor);
    });
    document.body.appendChild(marker);
    this.marker = marker;
    return marker;
  }

  private gapAt(clientY: number): { anchor: InsertAnchor; markerTop: number } | undefined {
    const rootRect = this.root.getBoundingClientRect();
    const y = clientY - rootRect.top + this.root.scrollTop;
    const children = this.root.children;
    let lo = 0;
    let hi = children.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const child = children[mid] as HTMLElement;
      if (child.offsetTop + child.offsetHeight <= y) lo = mid + 1;
      else hi = mid;
    }

    const isBlock = (element: Element): element is HTMLElement =>
      element instanceof HTMLElement && element.dataset.blockId !== undefined;
    let nextIndex = lo;
    while (nextIndex < children.length && !isBlock(children[nextIndex])) nextIndex++;
    let previousIndex = lo - 1;
    while (previousIndex >= 0 && !isBlock(children[previousIndex])) previousIndex--;

    const next = nextIndex < children.length ? children[nextIndex] as HTMLElement : undefined;
    const previous = previousIndex >= 0 ? children[previousIndex] as HTMLElement : undefined;
    if (!previous && !next) return undefined;
    if (next && y >= next.offsetTop) return undefined;

    const anchor: InsertAnchor = {};
    if (previous) anchor.afterBlockId = previous.dataset.blockId;
    if (next) anchor.beforeBlockId = next.dataset.blockId;

    const markerTop = previous && next
      ? (previous.offsetTop + previous.offsetHeight + next.offsetTop) / 2
      : next
        ? next.offsetTop
        : (previous as HTMLElement).offsetTop + (previous as HTMLElement).offsetHeight;
    return { anchor, markerTop };
  }

  private updateMarker(clientY: number): void {
    const found = this.gapAt(clientY);
    if (!found) {
      this.hideMarker();
      return;
    }
    const marker = this.ensureMarker();
    const rootRect = this.root.getBoundingClientRect();
    const top = Math.round(rootRect.top + found.markerTop - this.root.scrollTop) - 6;
    const unchanged = this.markerAnchor?.afterBlockId === found.anchor.afterBlockId
      && this.markerAnchor?.beforeBlockId === found.anchor.beforeBlockId
      && marker.style.top === `${top}px`;
    if (unchanged) return;
    this.markerAnchor = found.anchor;
    marker.style.left = `${Math.round(rootRect.left)}px`;
    marker.style.width = `${Math.round(rootRect.width)}px`;
    marker.style.top = `${top}px`;
    marker.hidden = false;
  }

  private open(anchor: InsertAnchor): void {
    if (this.active || this.isBlockEditing()) return;
    const element = document.createElement('div');
    element.className = 'markdown-source-preview-insert-editor';
    const textarea = document.createElement('textarea');
    textarea.className = 'markdown-source-preview-insert-editor__input';
    textarea.placeholder = 'Markdown…';
    element.appendChild(textarea);

    const before = anchor.beforeBlockId ? this.blocks.get(anchor.beforeBlockId) : undefined;
    const after = anchor.afterBlockId ? this.blocks.get(anchor.afterBlockId) : undefined;
    if (before) before.before(element);
    else if (after) after.after(element);
    else this.root.appendChild(element);

    this.active = { element, textarea, ...anchor };
    this.syncEmptyEditor();
    textarea.addEventListener('keydown', event => {
      const shortcut = handleTextareaShortcut(event);
      if (shortcut === 'native') return;
      if (shortcut === 'save') {
        this.commit(true);
        return;
      }
      if (shortcut === 'cancel') {
        this.commit(false);
      }
    }, { capture: true });
    textarea.addEventListener('blur', () => this.commit(true));
    textarea.focus();
  }

  private commit(save: boolean): void {
    const editor = this.active;
    if (!editor) return;
    this.active = undefined;
    const markdown = editor.textarea.value;
    editor.element.remove();
    this.syncEmptyEditor();
    if (!save || !markdown.trim()) return;
    this.post({
      type: 'insert-markdown',
      payload: {
        beforeBlockId: editor.beforeBlockId,
        afterBlockId: editor.afterBlockId,
        markdown,
      },
    });
  }
}
