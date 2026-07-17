import { describe, expect, it } from 'vitest';
import { DialogueSystem, type DialogueScript } from './DialogueSystem';

const script: DialogueScript = {
  id: 'test-intro',
  lines: [
    { speaker: 'Auntie Portia', text: 'Howzit boet.' },
    { speaker: 'You', text: 'Aweh.' },
    { speaker: 'Auntie Portia', text: 'Sharp sharp.' },
  ],
};

describe('DialogueSystem', () => {
  it('plays lines in order and finishes on the last advance', () => {
    const dialogue = new DialogueSystem();
    expect(dialogue.start(script)).toBe(true);
    expect(dialogue.active).toBe(true);
    expect(dialogue.line?.text).toBe('Howzit boet.');
    expect(dialogue.hasMore).toBe(true);
    expect(dialogue.advance()).toBe('line');
    expect(dialogue.line?.speaker).toBe('You');
    expect(dialogue.advance()).toBe('line');
    expect(dialogue.hasMore).toBe(false);
    expect(dialogue.advance()).toBe('finished');
    expect(dialogue.active).toBe(false);
    expect(dialogue.line).toBeUndefined();
  });

  it('is idle when nothing is playing', () => {
    const dialogue = new DialogueSystem();
    expect(dialogue.advance()).toBe('idle');
    expect(dialogue.active).toBe(false);
  });

  it('does not interrupt a running script and rejects empty scripts', () => {
    const dialogue = new DialogueSystem();
    expect(dialogue.start({ id: 'empty', lines: [] })).toBe(false);
    dialogue.start(script);
    expect(dialogue.start({ id: 'other', lines: [{ speaker: 'X', text: 'y' }] })).toBe(false);
    expect(dialogue.id).toBe('test-intro');
  });

  it('abandon drops the script mid-way without finishing', () => {
    const dialogue = new DialogueSystem();
    dialogue.start(script);
    dialogue.advance();
    dialogue.abandon();
    expect(dialogue.active).toBe(false);
    expect(dialogue.advance()).toBe('idle');
    // a fresh script can start again afterwards
    expect(dialogue.start(script)).toBe(true);
    expect(dialogue.line?.text).toBe('Howzit boet.');
  });
});
