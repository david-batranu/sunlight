/* Placeholder UI — replaced by the UI workstream. */
import type { AppState } from '../app/state.ts';
import type { UIHandle, UIContext } from '../app/contracts.ts';

export function createUI(root: HTMLElement, ctx: UIContext): UIHandle {
  root.innerHTML = `
    <div class="placeholder-panel">
      <h1>SUNLIGHT</h1>
      <p id="placeholder-city">Loading city…</p>
      <p id="placeholder-time">—</p>
      <p id="placeholder-status"></p>
      <button id="placeholder-reset" type="button">Reset camera</button>
    </div>
  `;
  const city = root.querySelector<HTMLElement>('#placeholder-city');
  const time = root.querySelector<HTMLElement>('#placeholder-time');
  const status = root.querySelector<HTMLElement>('#placeholder-status');
  root.querySelector('#placeholder-reset')?.addEventListener('click', () => ctx.actions.resetCamera());

  return {
    update(state: AppState) {
      if (city) city.textContent = state.city ? `${state.city.name}, ${state.city.country}` : 'Loading city…';
      if (time) time.textContent = `${state.date} ${Math.floor(state.minute / 60)}:${String(Math.floor(state.minute % 60)).padStart(2, '0')}`;
      if (status) {
        if (state.error) status.textContent = `${state.error.message}${state.error.retryable ? ' — retry available' : ''}`;
        else if (state.progress) status.textContent = `${state.progress.label} ${Math.round(state.progress.percent)}%`;
        else status.textContent = state.phase;
      }
    },
    destroy() {
      root.innerHTML = '';
    }
  };
}
