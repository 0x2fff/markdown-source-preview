export interface PendingSave {
  blockId: string;
  at: number;
  noOp: boolean;
}

// Save-exclusion state shared by blur and Cmd/Ctrl+S. This is product
// behavior, not diagnostics, so it must keep working in production
// builds where editMetrics is compiled out.
export class EditSaveController {
  private pending: PendingSave | undefined;

  hasPendingSave(): boolean {
    return this.pending !== undefined;
  }

  beginSave(blockId: string, noOp: boolean): void {
    this.pending = { blockId, at: performance.now(), noOp };
  }

  isNoOpSave(blockId: string): boolean {
    return this.pending?.blockId === blockId && this.pending.noOp;
  }

  consumeSave(blockId: string): PendingSave | undefined {
    if (this.pending?.blockId !== blockId) return undefined;
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  clearSave(): void {
    this.pending = undefined;
  }
}

export const editSave = new EditSaveController();
