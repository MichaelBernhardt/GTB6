import { describe, expect, it } from 'vitest';
import { clampPercent, formatMoney, objectiveProgress, reputationLabel } from './UIModels';

describe('UI view-model formatting', () => {
  it('clamps health and progress values for safe rendering', () => {
    expect(clampPercent(-3)).toBe(0); expect(clampPercent(54.6)).toBe(55); expect(clampPercent(150)).toBe(100);
  });

  it('formats objective progress only when both values exist', () => {
    expect(objectiveProgress({ missionName: 'Job', text: 'Go', progress: 2, required: 4 })).toBe(50);
    expect(objectiveProgress({ missionName: 'Job', text: 'Go', progress: 9, required: 4 })).toBe(100);
    expect(objectiveProgress({ missionName: 'Job', text: 'Go' })).toBeUndefined();
  });

  it('formats local currency and reputation labels consistently', () => {
    expect(formatMoney(1234.4)).toBe('R1,234'); expect(formatMoney(-20)).toBe('R0');
    expect(reputationLabel('trusted')).toBe('Trusted'); expect(reputationLabel('well-known')).toBe('Well-Known');
  });
});
