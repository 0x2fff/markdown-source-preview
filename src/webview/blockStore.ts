export class BlockStore {
  private readonly _idToEl = new Map<string, HTMLElement>();

  constructor(private readonly _root: HTMLElement) {
    // register blocks already present in the initial HTML
    this._scanExisting();
  }

  private _scanExisting(): void {
    const els = this._root.querySelectorAll<HTMLElement>('[data-block-id]');
    for (const el of els) {
      const id = el.dataset.blockId;
      if (id) this._idToEl.set(id, el);
    }
  }

  has(blockId: string): boolean {
    return this._idToEl.has(blockId);
  }

  get(blockId: string): HTMLElement | undefined {
    return this._idToEl.get(blockId);
  }

  /**
   * Inserts or updates a block. `beforeId` inserts before that element;
   * null/omitted appends at the end.
   */
  upsert(
    blockId: string,
    html: string,
    beforeId?: string | null,
    generation?: number,
    contentHash?: string,
  ): HTMLElement | null {
    const existing = this._idToEl.get(blockId);
    if (existing) {
      existing.outerHTML = html;
      // outerHTML replaces the element, so it must be re-fetched
      const newEl = this._root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
      if (newEl) {
        if (generation !== undefined) newEl.dataset.generation = String(generation);
        if (contentHash) newEl.dataset.contentHash = contentHash;
        this._idToEl.set(blockId, newEl);
      }
      return newEl;
    }

    // new insertion
    const temp = document.createElement('template');
    temp.innerHTML = html;
    const newEl = temp.content.firstElementChild as HTMLElement | null;
    if (!newEl) return null;

    if (generation !== undefined) newEl.dataset.generation = String(generation);
    if (contentHash) newEl.dataset.contentHash = contentHash;

    if (beforeId) {
      const beforeEl = this._idToEl.get(beforeId);
      if (beforeEl) {
        this._root.insertBefore(newEl, beforeEl);
        this._idToEl.set(blockId, newEl);
        return newEl;
      }
    }

    this._root.appendChild(newEl);
    this._idToEl.set(blockId, newEl);
    return newEl;
  }

  remove(blockId: string): void {
    const el = this._idToEl.get(blockId);
    if (el) {
      el.remove();
      this._idToEl.delete(blockId);
    }
  }

  blockIds(): string[] {
    const ids: string[] = [];
    const els = this._root.querySelectorAll<HTMLElement>('[data-block-id]');
    for (const el of els) {
      const id = el.dataset.blockId;
      if (id) ids.push(id);
    }
    return ids;
  }

  get size(): number {
    return this._idToEl.size;
  }
}
