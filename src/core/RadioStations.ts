export type RadioStationId = 'jozi-fm' | 'rank-radio' | 'braam-beats' | 'highveld-gold';

export interface RadioStation {
  id: RadioStationId;
  name: string;
  frequency: string;
  genre: string;
  tagline: string;
  bpm: number;
}

/** Fictional Jozi stations. Every station is rendered procedurally by AudioManager, so the soundtrack
 * stays original, tiny, and available offline. */
export const RADIO_STATIONS: readonly RadioStation[] = [
  { id: 'jozi-fm', name: 'Jozi FM', frequency: '94.7', genre: 'AMAPIANO', tagline: 'Log drums for the long way home.', bpm: 112 },
  { id: 'rank-radio', name: 'Rank Radio', frequency: '101.3', genre: 'MASKANDI', tagline: 'Strings, dust and taxi-rank stories.', bpm: 126 },
  { id: 'braam-beats', name: 'Braam Beats', frequency: '103.2', genre: 'GQOM', tagline: 'After dark, under the bridge.', bpm: 124 },
  { id: 'highveld-gold', name: 'Highveld Gold', frequency: '88.6', genre: 'KWAITO', tagline: 'Township classics, forever young.', bpm: 98 },
] as const;

export function radioStation(id: RadioStationId): RadioStation {
  return RADIO_STATIONS.find((station) => station.id === id) ?? RADIO_STATIONS[0]!;
}

/** The extra undefined entry is the physical radio's OFF position. */
export function cycleRadioStation(current: RadioStationId | undefined, direction = 1): RadioStationId | undefined {
  const choices: readonly (RadioStationId | undefined)[] = [...RADIO_STATIONS.map((station) => station.id), undefined];
  const index = choices.indexOf(current);
  return choices[((index < 0 ? 0 : index) + Math.sign(direction || 1) + choices.length) % choices.length];
}

export function radioDial(station?: RadioStation): string {
  return station ? `${station.name} ${station.frequency} · ${station.genre}` : 'RADIO OFF';
}
