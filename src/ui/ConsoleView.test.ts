import { describe, expect, it } from 'vitest';
import { HELP_LINES } from '../systems/Console';
import { morePrompt, pageOutput, pagerKeyAction } from './ConsoleView';

describe('console output paging', () => {
  it('prints short output whole, with nothing held back', () => {
    const short = ['Teleported to 2203, 2072.'];
    expect(pageOutput(short)).toEqual({ page: short, rest: [] });
    const exact = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    expect(pageOutput(exact)).toEqual({ page: exact, rest: [] }); // a full view is not worth a pager
  });

  it('cuts long output a row short, because the footer is a row', () => {
    const lines = Array.from({ length: 28 }, (_, i) => `line ${i}`);
    const first = pageOutput(lines);
    expect(first.page).toHaveLength(9);
    expect(first.page[0]).toBe('line 0'); // the TOP of the list, which is what used to scroll away
    expect(first.rest).toHaveLength(19);
    const second = pageOutput(first.rest);
    expect(second.page).toHaveLength(9);
    expect(second.rest).toHaveLength(10);
    const third = pageOutput(second.rest);
    expect(third.page).toHaveLength(10);
    expect(third.rest).toEqual([]); // the last page needs no footer
  });

  it('walks the whole of a real `help` in pages, losing no line and repeating none', () => {
    const seen: string[] = [];
    let rest = HELP_LINES as string[];
    for (let page = 0; rest.length > 0 && page < 20; page++) { const split = pageOutput(rest); seen.push(...split.page); rest = split.rest; }
    expect(seen).toEqual([...HELP_LINES]);
  });

  it('says how much is left, in plain words', () => {
    expect(morePrompt(19)).toBe('[SPACE for more — 19 more lines]');
    expect(morePrompt(1)).toBe('[SPACE for more — 1 more line]');
  });

  it('only claims SPACE while a page is actually held', () => {
    expect(pagerKeyAction('Space', true)).toBe('advance');
    expect(pagerKeyAction('Space', false)).toBe('none'); // an ordinary space in the command line
    expect(pagerKeyAction('KeyM', false)).toBe('none');
  });

  it('lets any other keystroke abandon the rest and do its normal job', () => {
    expect(pagerKeyAction('KeyM', true)).toBe('cancel');
    expect(pagerKeyAction('Enter', true)).toBe('cancel');
    expect(pagerKeyAction('Escape', true)).toBe('cancel');
    for (const modifier of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'CapsLock']) expect(pagerKeyAction(modifier, true)).toBe('none'); // typing a capital is not abandoning
  });
});
