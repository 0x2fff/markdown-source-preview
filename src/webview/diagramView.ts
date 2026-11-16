/**
 * Viewport controls for Mermaid output (.mermaid-output):
 * Ctrl/Cmd+wheel zooms around the cursor (trackpad pinch arrives as
 * ctrlKey wheel), Alt/Option+drag pans. The transform lives on the
 * output element itself, so it survives Mermaid re-renders.
 */

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const ZOOM_SPEED = 0.0015;

interface ViewState {
  scale: number;
  x: number;
  y: number;
}

interface PanState {
  output: HTMLElement;
  pointerId: number;
  lastX: number;
  lastY: number;
  prevUserSelect: string;
}

export function attachDiagramView(root: HTMLElement, signal: AbortSignal): void {
  const states = new WeakMap<HTMLElement, ViewState>();

  const stateOf = (el: HTMLElement): ViewState => {
    let state = states.get(el);
    if (!state) {
      state = { scale: 1, x: 0, y: 0 };
      states.set(el, state);
    }
    return state;
  };

  const apply = (el: HTMLElement, state: ViewState): void => {
    el.style.transformOrigin = '0 0';
    el.style.transform = state.scale === 1 && state.x === 0 && state.y === 0
      ? ''
      : `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  };

  const outputOf = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const output = target.closest('.mermaid-output');
    return output instanceof HTMLElement && root.contains(output) ? output : null;
  };

  root.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const output = outputOf(event.target);
    if (!output) return;
    event.preventDefault();

    const state = stateOf(output);
    const rect = output.getBoundingClientRect();
    // post-transform top-left = layout origin P + (x, y); solve for P
    const px = rect.left - state.x;
    const py = rect.top - state.y;
    const prev = state.scale;
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, prev * Math.exp(-event.deltaY * ZOOM_SPEED)),
    );
    if (next === prev) return;

    // keep the content point under the cursor fixed across zoom
    const lx = (event.clientX - px - state.x) / prev;
    const ly = (event.clientY - py - state.y) / prev;
    state.scale = next;
    state.x = event.clientX - px - next * lx;
    state.y = event.clientY - py - next * ly;
    apply(output, state);
  }, { passive: false, signal });

  let panning: PanState | null = null;

  const endPan = (): void => {
    if (!panning) return;
    panning.output.style.userSelect = panning.prevUserSelect;
    panning.output.classList.remove('is-panning');
    panning = null;
  };

  root.addEventListener('pointerdown', (event) => {
    if (!event.altKey || event.button !== 0) return;
    const output = outputOf(event.target);
    if (!output) return;
    event.preventDefault();
    panning = {
      output,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      prevUserSelect: output.style.userSelect,
    };
    output.style.userSelect = 'none';
    output.classList.add('is-panning');
    output.setPointerCapture?.(event.pointerId);
  }, { signal });

  root.addEventListener('pointermove', (event) => {
    if (!panning || panning.pointerId !== event.pointerId) return;
    const state = stateOf(panning.output);
    state.x += event.clientX - panning.lastX;
    state.y += event.clientY - panning.lastY;
    panning.lastX = event.clientX;
    panning.lastY = event.clientY;
    apply(panning.output, state);
  }, { signal });

  root.addEventListener('pointerup', endPan, { signal });
  root.addEventListener('pointercancel', endPan, { signal });
}
