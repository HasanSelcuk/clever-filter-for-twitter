/**
 * Everything the extension draws on X. State lives in data attributes on X's timeline cells,
 * and content.css turns those attributes into the visible result. The only element added to
 * the page is the one-line label of a hidden post, appended as the cell's last child.
 */

const SCAN_MS = 900;
const COLLAPSE_MS = 380;
/** Height of the scan band in content.css. */
const BAND_PX = 56;

export interface HideInfo {
  ruleName: string;
  detail: string;
  style: 'label' | 'remove';
  animate: boolean;
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function isOnScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight && r.height > 0;
}

export function setChecking(cell: HTMLElement, on: boolean): void {
  if (on) cell.dataset.cfState = 'checking';
  else if (cell.dataset.cfState === 'checking') delete cell.dataset.cfState;
}

function labelOf(cell: HTMLElement): HTMLElement | null {
  const last = cell.lastElementChild;
  return last instanceof HTMLElement && last.classList.contains('cf-label') ? last : null;
}

function ensureLabel(cell: HTMLElement, info: HideInfo, onToggle: () => void): HTMLElement {
  let label = labelOf(cell);
  if (!label) {
    label = document.createElement('div');
    label.className = 'cf-label';
    const text = document.createElement('span');
    text.className = 'cf-label-text';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cf-label-button';
    label.append(text, button);
    cell.append(label);
  }
  label.title = info.detail;
  const button = label.querySelector<HTMLButtonElement>('.cf-label-button')!;
  button.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle();
  };
  return label;
}

function setLabelText(cell: HTMLElement, revealed: boolean, ruleName: string): void {
  const label = labelOf(cell);
  if (!label) return;
  label.querySelector('.cf-label-text')!.textContent = `${revealed ? 'Shown' : 'Hidden'}: ${ruleName}`;
  label.querySelector('.cf-label-button')!.textContent = revealed ? 'Hide' : 'Show';
}

/** Content of the cell other than our label: the part that collapses. */
function contentOf(cell: HTMLElement): HTMLElement | null {
  const first = cell.firstElementChild;
  return first instanceof HTMLElement && !first.classList.contains('cf-label') ? first : null;
}

function clearInline(el: HTMLElement | null): void {
  if (!el) return;
  el.style.removeProperty('max-height');
  el.style.removeProperty('overflow');
  el.style.removeProperty('transition');
  el.style.removeProperty('opacity');
}

/**
 * Hides a post. On screen, with the animation on, a scan line runs over the post, the post fades
 * and collapses, and the label takes its place. Off screen, it collapses at once.
 */
export function hide(cell: HTMLElement, info: HideInfo, revealed: boolean, onToggle: () => void): void {
  const id = cell.dataset.cfId;
  if (info.style === 'remove') {
    labelOf(cell)?.remove();
    if (cell.dataset.cfView !== 'removed' && cell.dataset.cfView !== 'hiding') {
      animateOut(cell, id, info.animate, 'removed');
    }
    return;
  }
  ensureLabel(cell, info, onToggle);
  setLabelText(cell, revealed, info.ruleName);
  if (revealed) {
    cell.dataset.cfView = 'revealed';
    clearInline(contentOf(cell));
    return;
  }
  const view = cell.dataset.cfView;
  if (view === 'hidden' || view === 'hiding') return;
  animateOut(cell, id, info.animate && view !== 'revealed', 'hidden');
}

function animateOut(cell: HTMLElement, id: string | undefined, animate: boolean, end: 'hidden' | 'removed'): void {
  if (!animate || reducedMotion() || !isOnScreen(cell)) {
    cell.dataset.cfView = end;
    return;
  }
  const content = contentOf(cell);
  cell.dataset.cfView = 'hiding';
  if (content) {
    content.style.maxHeight = `${content.offsetHeight}px`;
    content.style.overflow = 'hidden';
    cell.style.setProperty('--cf-scan-end', `${Math.max(0, content.offsetHeight - BAND_PX)}px`);
  }
  const stillOurs = () => cell.isConnected && cell.dataset.cfId === id && cell.dataset.cfView === 'hiding';
  setTimeout(() => {
    if (!stillOurs() || !content) return;
    content.style.transition = `max-height ${COLLAPSE_MS}ms ease-in, opacity ${COLLAPSE_MS}ms ease-in`;
    content.style.maxHeight = '0px';
    content.style.opacity = '0';
  }, SCAN_MS);
  setTimeout(() => {
    if (!stillOurs()) return;
    cell.dataset.cfView = end;
    clearInline(content);
  }, SCAN_MS + COLLAPSE_MS);
}

/** Removes every trace of the extension from a cell. */
export function reset(cell: HTMLElement): void {
  labelOf(cell)?.remove();
  clearInline(contentOf(cell));
  cell.style.removeProperty('--cf-scan-end');
  delete cell.dataset.cfView;
  delete cell.dataset.cfState;
  delete cell.dataset.cfFlash;
}

/** Shows a short note on a post after the extension liked or bookmarked it. */
export function flash(cell: HTMLElement, text: string, animate: boolean): void {
  if (!animate || reducedMotion()) return;
  cell.dataset.cfFlash = text;
  const id = cell.dataset.cfId;
  setTimeout(() => {
    if (cell.dataset.cfId === id && cell.dataset.cfFlash === text) delete cell.dataset.cfFlash;
  }, 2200);
}
