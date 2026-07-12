import { describe, expect, it } from 'vitest';
import { cycleRadioStation, radioDial, RADIO_STATIONS } from './RadioStations';

describe('in-car radio dial', () => {
  it('gives every station distinct tuning and identity', () => {
    expect(new Set(RADIO_STATIONS.map((station) => station.id)).size).toBe(RADIO_STATIONS.length);
    expect(new Set(RADIO_STATIONS.map((station) => station.frequency)).size).toBe(RADIO_STATIONS.length);
    expect(new Set(RADIO_STATIONS.map((station) => station.genre)).size).toBe(RADIO_STATIONS.length);
  });

  it('cycles through stations, off, and back around in either direction', () => {
    expect(cycleRadioStation('jozi-fm')).toBe('rank-radio');
    expect(cycleRadioStation('highveld-gold')).toBeUndefined();
    expect(cycleRadioStation(undefined)).toBe('jozi-fm');
    expect(cycleRadioStation('jozi-fm', -1)).toBeUndefined();
  });

  it('formats a compact dashboard label', () => {
    expect(radioDial(RADIO_STATIONS[0])).toBe('Jozi FM 94.7 · AMAPIANO');
    expect(radioDial()).toBe('RADIO OFF');
  });
});
