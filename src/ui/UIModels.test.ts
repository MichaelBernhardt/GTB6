import { describe, expect, it } from 'vitest';
import { clampPercent, dialogueAdvanceLabel, formatMoney, objectiveProgress, reputationLabel, TOAST_MS, toastVisibleAt } from './UIModels';

describe('toast auto-hide is wall-clock based', () => {
  // Regression: the old implementation decremented 1/60s per HUD update (per rendered frame),
  // so on a phone rendering a few fps "4 seconds" became minutes and the toast never left.
  it('expires exactly TOAST_MS after notify, regardless of how few frames rendered', () => {
    const shown = 100_000; const deadline = shown + TOAST_MS;
    expect(toastVisibleAt(shown + 100, deadline)).toBe(true);
    expect(toastVisibleAt(shown + TOAST_MS - 1, deadline)).toBe(true);
    expect(toastVisibleAt(shown + TOAST_MS, deadline)).toBe(false);
    // 0.25fps phone: the first HUD update after the deadline hides it, however late it lands
    expect(toastVisibleAt(shown + 60_000, deadline)).toBe(false);
  });
  it('a replacement toast restarts the clock from its own notify time', () => {
    const secondDeadline = 200_000 + TOAST_MS;
    expect(toastVisibleAt(200_000 + TOAST_MS - 1, secondDeadline)).toBe(true);
    expect(toastVisibleAt(200_000 + TOAST_MS + 1, secondDeadline)).toBe(false);
  });
});

describe('UI view-model formatting', () => {
  it('clamps health and progress values for safe rendering', () => {
    expect(clampPercent(-3)).toBe(0); expect(clampPercent(54.6)).toBe(55); expect(clampPercent(150)).toBe(100);
  });

  it('formats objective progress only when both values exist', () => {
    expect(objectiveProgress({ missionName: 'Job', text: 'Go', progress: 2, required: 4 })).toBe(50);
    expect(objectiveProgress({ missionName: 'Job', text: 'Go', progress: 9, required: 4 })).toBe(100);
    expect(objectiveProgress({ missionName: 'Job', text: 'Go' })).toBeUndefined();
  });

  it('labels the dialogue advance key, demanding an explicit accept on job offers', () => {
    expect(dialogueAdvanceLabel({ speaker: 'Portia', text: 'Howzit', more: true, offer: true })).toBe('E  MORE');
    expect(dialogueAdvanceLabel({ speaker: 'Portia', text: 'Deal?', more: false, offer: true })).toBe('E  TAKE THE JOB');
    expect(dialogueAdvanceLabel({ speaker: 'Portia', text: 'Cheers', more: false })).toBe('E  DONE');
  });

  it('formats local currency and reputation labels consistently', () => {
    expect(formatMoney(1234.4)).toBe('R1,234'); expect(formatMoney(-20)).toBe('R0');
    expect(reputationLabel('trusted')).toBe('Trusted'); expect(reputationLabel('well-known')).toBe('Well-Known');
  });
});
