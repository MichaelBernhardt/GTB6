const MAX_LINES = 10;

/** Keys that are not "some other input": holding Shift to type a capital must not abandon a held page. */
const MODIFIER_CODES: ReadonlySet<string> = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock']);

/**
 * Split a command's output into what the view can show now and what waits for SPACE.
 *
 * The log holds MAX_LINES rows and drops the oldest, so a 28-line `help` used to print its way
 * straight off the top and leave the player looking at the bottom handful — the whole of the fault.
 * Anything longer than the view is cut a row short, because the footer that says so IS a row.
 */
export const pageOutput = (lines: string[], capacity = MAX_LINES): { page: string[]; rest: string[] } =>
  lines.length <= capacity ? { page: lines, rest: [] } : { page: lines.slice(0, capacity - 1), rest: lines.slice(capacity - 1) };

/** The footer that stands in for the lines being held back. */
export const morePrompt = (remaining: number): string => `[SPACE for more — ${remaining} more line${remaining === 1 ? '' : 's'}]`;

/** What a keystroke means to the pager. It answers 'none' whenever no page is held, which is what keeps
 *  SPACE an ordinary space in the command line — and the game's jump/handbrake untouched, since the
 *  console suspends game input for as long as it is open at all. */
export const pagerKeyAction = (code: string, paging: boolean): 'advance' | 'cancel' | 'none' => {
  if (!paging) return 'none';
  if (code === 'Space') return 'advance';
  return MODIFIER_CODES.has(code) ? 'none' : 'cancel';
};

/** Quake-style command line: scrolling output above a single input row. Keyboard is handled here while
 *  visible (game input is suspended by the caller); Up/Down walks the submitted-command history, and
 *  output longer than the view is paged with SPACE rather than scrolled away. */
export class ConsoleView {
  root = document.createElement('div');
  private log = document.createElement('div');
  private field = document.createElement('input');
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
  private pending: string[] = [];
  private footer?: HTMLElement;
  onSubmit?: (text: string) => void;
  onClose?: () => void;

  constructor() {
    this.root.id = 'console'; this.root.setAttribute('aria-hidden', 'true'); this.log.className = 'console-log'; this.log.setAttribute('role', 'log');
    const line = document.createElement('div'); line.className = 'console-line';
    const chevron = document.createElement('span'); chevron.textContent = ']'; chevron.setAttribute('aria-hidden', 'true');
    this.field.type = 'text'; this.field.spellcheck = false; this.field.autocomplete = 'off'; this.field.setAttribute('aria-label', 'Console command');
    line.append(chevron, this.field); this.root.append(this.log, line);
    this.field.addEventListener('keydown', (event) => this.handleKey(event));
    this.field.addEventListener('blur', () => { if (this.open) setTimeout(() => { if (this.open) this.field.focus(); }, 0); });
  }

  get open(): boolean { return this.root.classList.contains('is-visible'); }

  show(): void {
    this.root.classList.add('is-visible'); this.root.setAttribute('aria-hidden', 'false');
    this.field.value = ''; this.draft = ''; this.historyIndex = this.history.length; this.field.focus();
  }

  hide(): void { this.endPaging(); this.root.classList.remove('is-visible'); this.root.setAttribute('aria-hidden', 'true'); this.field.blur(); }

  /** Print one command's output. A fresh result always supersedes a page still waiting to be read. */
  print(lines: string[]): void {
    this.endPaging();
    this.pending = [...lines];
    this.flushPage();
  }

  /** Emit as much of `pending` as fits, and hold the rest behind the footer. */
  private flushPage(): void {
    const { page, rest } = pageOutput(this.pending);
    this.pending = rest;
    for (const text of page) this.append(text);
    if (rest.length > 0) { this.footer = this.append(morePrompt(rest.length)); this.footer.className = 'console-more'; }
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove();
  }

  private append(text: string): HTMLElement {
    const row = document.createElement('div'); row.textContent = text; this.log.append(row);
    return row;
  }

  private dropFooter(): void { this.footer?.remove(); this.footer = undefined; }

  /** Abandon whatever is still held: the footer's promise stops being true the moment anything else runs. */
  private endPaging(): void { this.dropFooter(); this.pending = []; }

  private handleKey(event: KeyboardEvent): void {
    event.stopPropagation();
    const paging = pagerKeyAction(event.code, this.pending.length > 0);
    if (paging === 'advance') { event.preventDefault(); this.dropFooter(); this.flushPage(); return; }
    if (paging === 'cancel') this.endPaging(); // and the keystroke goes on to do its normal job below
    if (event.code === 'Backquote' || event.code === 'Escape') { event.preventDefault(); this.onClose?.(); return; }
    if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      const text = this.field.value.trim(); this.field.value = ''; this.draft = '';
      if (!text) return;
      this.history.push(text); this.historyIndex = this.history.length;
      this.print([`] ${text}`]); this.onSubmit?.(text);
      return;
    }
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
      if (this.history.length === 0) return;
      if (this.historyIndex === this.history.length) this.draft = this.field.value;
      this.historyIndex = Math.min(this.history.length, Math.max(0, this.historyIndex + (event.code === 'ArrowUp' ? -1 : 1)));
      this.field.value = this.history[this.historyIndex] ?? this.draft;
    }
  }
}
