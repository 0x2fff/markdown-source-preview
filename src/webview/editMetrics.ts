/**
 * Input and save latency metrics for editor islands.
 * Exposed on window.__MARKDOWN_SOURCE_PREVIEW_EDIT_METRICS__ for diagnostics.
 */

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

const NAMES: EditMetricName[] = [
  'islandStartMs',
  'asciiInputMs',
  'imeCommitMs',
  'noOpSaveMs',
  'blockSaveMs',
  'cancelMs',
];

function emptySamples(): Record<EditMetricName, number[]> {
  return {
    islandStartMs: [],
    asciiInputMs: [],
    imeCommitMs: [],
    noOpSaveMs: [],
    blockSaveMs: [],
    cancelMs: [],
  };
}

class EditMetrics {
  private _samples = emptySamples();
  private _longTasks: number[] = [];

  record(name: EditMetricName, ms: number): void {
    if (!__MARKDOWN_SOURCE_PREVIEW_LAB__ || !Number.isFinite(ms) || ms < 0) return;
    this._samples[name].push(+ms.toFixed(3));
  }

  recordLongTask(duration: number): void {
    if (!__MARKDOWN_SOURCE_PREVIEW_LAB__ || !Number.isFinite(duration) || duration <= 0) return;
    this._longTasks.push(+duration.toFixed(3));
  }

  reset(): void {
    this._samples = emptySamples();
    this._longTasks.length = 0;
  }

  snapshot(): EditMetricsSnapshot {
    return {
      samples: Object.fromEntries(
        NAMES.map(name => [name, [...this._samples[name]]]),
      ) as Record<EditMetricName, number[]>,
      longTasks: [...this._longTasks],
      longTaskMaxMs: this._longTasks.length ? Math.max(...this._longTasks) : null,
    };
  }
}

export const editMetrics = new EditMetrics();
