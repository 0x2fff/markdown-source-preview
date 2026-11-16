export type EditMetricName =
  | 'islandStartMs'
  | 'asciiInputMs'
  | 'imeCommitMs'
  | 'noOpSaveMs'
  | 'blockSaveMs'
  | 'cancelMs';

export interface EditMetricsSnapshot {
  samples: Record<EditMetricName, number[]>;
  longTasks: number[];
  longTaskMaxMs: number | null;
}

export interface EditMetrics {
  record(name: EditMetricName, ms: number): void;
  markBegin(): void;
  consumeBegin(): number | undefined;
  markKeyInput(): void;
  compositionStart(): void;
  compositionEnd(): void;
  consumeInput(): { startedAt: number; ime: boolean };
  beginSave(blockId: string, noOp: boolean): void;
  finishSave(blockId: string): void;
  markCancel(): void;
  finishCancel(): void;
  patchApplied(changed: boolean): void;
  recordLongTask(duration: number): void;
  reset(): void;
  snapshot(): EditMetricsSnapshot;
}

const NAMES: EditMetricName[] = [
  'islandStartMs',
  'asciiInputMs',
  'imeCommitMs',
  'noOpSaveMs',
  'blockSaveMs',
  'cancelMs',
];

function emptySamples(): Record<EditMetricName, number[]> {
  return Object.fromEntries(NAMES.map(name => [name, [] as number[]])) as Record<EditMetricName, number[]>;
}

class EditMetricsController implements EditMetrics {
  private samples = emptySamples();
  private longTasks: number[] = [];
  private beginAt: number | undefined;
  private lastInputAt: number | undefined;
  private compositionStartedAt: number | undefined;
  private compositionEndedAt: number | undefined;
  private pendingSave: { blockId: string; noOp: boolean; at: number } | undefined;
  private cancelAt: number | undefined;

  record(name: EditMetricName, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples[name].push(+ms.toFixed(3));
  }

  markBegin(): void {
    this.beginAt = performance.now();
  }

  consumeBegin(): number | undefined {
    const value = this.beginAt;
    this.beginAt = undefined;
    return value;
  }

  markKeyInput(): void {
    this.lastInputAt = performance.now();
  }

  compositionStart(): void {
    this.compositionStartedAt = performance.now();
    this.compositionEndedAt = undefined;
  }

  compositionEnd(): void {
    this.compositionEndedAt = performance.now();
  }

  consumeInput(): { startedAt: number; ime: boolean } {
    const now = performance.now();
    const result = {
      startedAt: this.compositionEndedAt ?? this.lastInputAt ?? now,
      ime: this.compositionEndedAt !== undefined || this.compositionStartedAt !== undefined,
    };
    this.compositionStartedAt = undefined;
    this.compositionEndedAt = undefined;
    this.lastInputAt = undefined;
    return result;
  }

  // Records diagnostics timing only; save exclusion lives in
  // EditSaveController and remains active in production builds.
  beginSave(blockId: string, noOp: boolean): void {
    this.pendingSave = { blockId, noOp, at: performance.now() };
  }

  finishSave(blockId: string): void {
    const pending = this.pendingSave;
    if (!pending || pending.blockId !== blockId || !pending.noOp) return;
    this.pendingSave = undefined;
    this.record('noOpSaveMs', performance.now() - pending.at);
  }

  markCancel(): void {
    this.cancelAt = performance.now();
  }

  finishCancel(): void {
    if (this.cancelAt !== undefined) this.record('cancelMs', performance.now() - this.cancelAt);
    this.cancelAt = undefined;
    this.pendingSave = undefined;
  }

  patchApplied(changed: boolean): void {
    if (!changed || !this.pendingSave) return;
    this.record('blockSaveMs', performance.now() - this.pendingSave.at);
    this.pendingSave = undefined;
  }

  recordLongTask(duration: number): void {
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.longTasks.push(+duration.toFixed(3));
  }

  reset(): void {
    this.samples = emptySamples();
    this.longTasks.length = 0;
    this.beginAt = undefined;
    this.lastInputAt = undefined;
    this.compositionStartedAt = undefined;
    this.compositionEndedAt = undefined;
    this.pendingSave = undefined;
    this.cancelAt = undefined;
  }

  snapshot(): EditMetricsSnapshot {
    return {
      samples: Object.fromEntries(
        NAMES.map(name => [name, [...this.samples[name]]]),
      ) as Record<EditMetricName, number[]>,
      longTasks: [...this.longTasks],
      longTaskMaxMs: this.longTasks.length ? Math.max(...this.longTasks) : null,
    };
  }
}

export const editMetrics = /* @__PURE__ */ new EditMetricsController();
