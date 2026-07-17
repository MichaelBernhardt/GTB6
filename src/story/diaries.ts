import { DIARY_SPOTS } from '../world/placements';

/**
 * The Grid Diary: twelve torn pages from a fired Eskom load-planner's notebook — the man
 * who first sold Solly the idea. Pages 1 and 2 come from missions (The Reading of the
 * Signs, Paper Round); pages 3–12 lie in the world at the city's proudest places, and
 * each page's text quietly points at another. Collecting all twelve pays out a stash.
 */
export interface DiaryPageContent { page: number; text: string; }

export const DIARY_TEXTS: Readonly<Record<number, string>> = {
  1: 'They fired me for a spreadsheet. The spreadsheet said the outages don\'t match the load. Nobody wanted the spreadsheet. — J.T.',
  2: 'A man from the generator business bought me brandy and asked very specific questions about feeder schedules. I answered them. God help me, I itemised.',
  3: 'I watch the city from the tower some nights. When a blackout rolls in you can see its EDGE move. Rolling blackouts don\'t have edges. Scheduled ones do.',
  4: 'Took my spreadsheet to a lawyer near the old prison. She read two pages and asked who else knew. I lied and said nobody. She knew I lied.',
  5: 'The cylinder building. Fifty-four floors of people who buy candles by the crate. Somebody sells them the candles too. I checked. Same holding company.',
  6: 'I still come to the station to hear the announcements. The old announcer knows my face now. If anything happens to me, I told him where I walk.',
  7: 'Fed the ducks. Wrote the truth on the back of a braai receipt and posted it to myself. If the seal is broken, it wasn\'t me who broke it.',
  8: 'Drove out past the mountain until the city lights stopped mattering. The old lady at the padstal says the power never trips out here. No paying customers, I told her. She didn\'t laugh.',
  9: 'At the pier the sea does what the grid does — goes out and comes back. Except nobody bills the sea. Watched it until dark. The dark came from the city side.',
  10: 'Small planes leave the regional strip at night with no manifests. I counted drums, not suitcases, going into one. Diesel flies economy class now.',
  11: 'Followed the money north to the fancy station. The security firm that guards half of Sandton bills for backup diesel on sites that have no tanks. I measured the tanks. There are no tanks.',
  12: 'The yard on the Crown side has floodlights like a border post and a generator that has never once run. I stood at the fence and understood everything. Tomorrow I take it all to the lawyer.',
};

export const DIARY_STASH_REWARD = 5000;
export const DIARY_STASH_NOTE = 'Page 12 was the last. J.T. never made it to the lawyer — but his stash was where the pages said it would be.';

/** World spots (pages 3–12) joined with their text. Pages 1–2 are mission payouts. */
export const DIARY_WORLD_PAGES = DIARY_SPOTS.map((spot) => ({ ...spot, text: DIARY_TEXTS[spot.page] ?? '' }));
