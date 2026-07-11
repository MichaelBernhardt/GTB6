const MAX_LINES = 10;

/** Quake-style command line: scrolling output above a single input row. Keyboard is handled here while
 *  visible (game input is suspended by the caller); Up/Down walks the submitted-command history. */
export class ConsoleView {
  root = document.createElement('div');
  private log = document.createElement('div');
  private field = document.createElement('input');
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
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

  hide(): void { this.root.classList.remove('is-visible'); this.root.setAttribute('aria-hidden', 'true'); this.field.blur(); }

  print(lines: string[]): void {
    for (const text of lines) { const row = document.createElement('div'); row.textContent = text; this.log.append(row); }
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove();
  }

  private handleKey(event: KeyboardEvent): void {
    event.stopPropagation();
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
