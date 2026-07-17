export const AMBIENT_NPC_CHARACTER_IDS = [
  'braamfontein-creative',
  'sandton-professional',
  'rosebank-athlete',
  'melville-creative',
  'newtown-producer',
  'fordsburg-restaurateur',
  'maboneng-courier',
  'parkhurst-architect',
] as const;

export const NPC_CHARACTER_IDS = [
  ...AMBIENT_NPC_CHARACTER_IDS,
  'auntie-portia',
  'bra-vusi',
  'candice-boksburg',
  'thandi-arms',
  'jmpd-patrol-officer',
  'bree-rank-enforcer',
  'yeoville-car-guard',
  'joburg-driver',
] as const;

export type NpcCharacterId = typeof NPC_CHARACTER_IDS[number];
export type NpcCharacterRole = 'ambient' | 'contact' | 'police' | 'hostile' | 'guard' | 'driver';

export const MISSION_CONTACT_NPC_IDS: Readonly<Record<string, NpcCharacterId>> = {
  'delivery-run': 'auntie-portia',
  'hot-property': 'bra-vusi',
  'dockside-signal': 'candice-boksburg',
  'arms-deal': 'thandi-arms',
  // Story arc (models reuse existing bodies; contact labels carry the character names)
  'last-coach-home': 'auntie-portia',
  'copper-wire-blues': 'bra-vusi',
  'rank-cold-war': 'candice-boksburg',
  'reading-signs': 'joburg-driver', // Oupa Jakes
};
export const JMPD_PATROL_NPC_ID: NpcCharacterId = 'jmpd-patrol-officer';
export const RANK_ENFORCER_NPC_ID: NpcCharacterId = 'bree-rank-enforcer';
export const CAR_GUARD_NPC_ID: NpcCharacterId = 'yeoville-car-guard';
export const DRIVER_NPC_ID: NpcCharacterId = 'joburg-driver';

export interface NpcCharacterMetadata {
  id: NpcCharacterId;
  displayName: string;
  age: number;
  sex: 'female' | 'male';
  role: NpcCharacterRole;
  district: string;
  archetype: string;
  description: string;
  modelUrl: string;
}

const npc = (metadata: Omit<NpcCharacterMetadata, 'modelUrl'>): NpcCharacterMetadata => ({
  ...metadata,
  modelUrl: `/models/npcs/${metadata.id}.glb`,
});

export const NPC_CATALOG: Readonly<Record<NpcCharacterId, NpcCharacterMetadata>> = {
  'braamfontein-creative': npc({
    id: 'braamfontein-creative', displayName: 'Lerato', age: 27, sex: 'female', role: 'ambient', district: 'Braamfontein', archetype: 'creative',
    description: 'Black South African creative in fitted rust streetwear, dark teal trousers and braids.',
  }),
  'sandton-professional': npc({
    id: 'sandton-professional', displayName: 'Priya', age: 30, sex: 'female', role: 'ambient', district: 'Sandton', archetype: 'professional',
    description: 'South African Indian professional in deep-plum office-glam tailoring and long hair.',
  }),
  'rosebank-athlete': npc({
    id: 'rosebank-athlete', displayName: 'Mia', age: 25, sex: 'female', role: 'ambient', district: 'Rosebank', archetype: 'athlete',
    description: 'Coloured South African athlete in fitted coral and graphite sportswear with a ponytail.',
  }),
  'melville-creative': npc({
    id: 'melville-creative', displayName: 'Hannah', age: 29, sex: 'female', role: 'ambient', district: 'Melville', archetype: 'creative',
    description: 'White South African creative in an ochre weekend top, dark denim and a chestnut bob.',
  }),
  'newtown-producer': npc({
    id: 'newtown-producer', displayName: 'Thabo Maseko', age: 28, sex: 'male', role: 'ambient', district: 'Newtown', archetype: 'producer',
    description: 'Black South African music producer in indigo workwear and charcoal chinos.',
  }),
  'fordsburg-restaurateur': npc({
    id: 'fordsburg-restaurateur', displayName: 'Imraan Patel', age: 31, sex: 'male', role: 'ambient', district: 'Fordsburg', archetype: 'restaurateur',
    description: 'South African Indian restaurateur in olive smart-casual tailoring.',
  }),
  'maboneng-courier': npc({
    id: 'maboneng-courier', displayName: 'Kabelo Nkosi', age: 24, sex: 'male', role: 'ambient', district: 'Maboneng', archetype: 'courier',
    description: 'Black South African bicycle courier in cobalt and graphite sportswear.',
  }),
  'parkhurst-architect': npc({
    id: 'parkhurst-architect', displayName: 'Daniel van Wyk', age: 32, sex: 'male', role: 'ambient', district: 'Parkhurst', archetype: 'architect',
    description: 'White South African architect in sand fieldwear and dark denim.',
  }),
  'auntie-portia': npc({
    id: 'auntie-portia', displayName: 'Auntie Portia Mokoena', age: 55, sex: 'female', role: 'contact', district: 'Johannesburg South', archetype: 'mission-contact',
    description: 'Warm, formidable delivery-job contact in berry and charcoal.',
  }),
  'bra-vusi': npc({
    id: 'bra-vusi', displayName: 'Bra Vusi Mthembu', age: 44, sex: 'male', role: 'contact', district: 'Braamfontein', archetype: 'mission-contact',
    description: 'Streetwise lock-up owner in a muted teal-and-rust micro-check shirt.',
  }),
  'candice-boksburg': npc({
    id: 'candice-boksburg', displayName: 'Candice Jacobs', age: 34, sex: 'female', role: 'contact', district: 'Boksburg', archetype: 'mission-contact',
    description: 'Determined taxi-route organizer in bottle-green utility streetwear.',
  }),
  'thandi-arms': npc({
    id: 'thandi-arms', displayName: 'Thandi Ndlovu', age: 38, sex: 'female', role: 'contact', district: 'Joburg CBD', archetype: 'mission-contact',
    description: 'Authoritative independent shop manager in graphite and olive workwear.',
  }),
  'jmpd-patrol-officer': npc({
    id: 'jmpd-patrol-officer', displayName: 'Sergeant Themba Dlamini', age: 36, sex: 'male', role: 'police', district: 'Joburg CBD', archetype: 'patrol-officer',
    description: 'Fictional metropolitan foot-patrol officer in blank dark-navy uniform.',
  }),
  'bree-rank-enforcer': npc({
    id: 'bree-rank-enforcer', displayName: 'Sizwe Khumalo', age: 33, sex: 'male', role: 'hostile', district: 'Bree', archetype: 'rank-enforcer',
    description: 'Imposing taxi-rank enforcer in charcoal workwear and dark denim.',
  }),
  'yeoville-car-guard': npc({
    id: 'yeoville-car-guard', displayName: 'Uncle Jabu Maseko', age: 52, sex: 'male', role: 'guard', district: 'Yeoville', archetype: 'car-guard',
    description: 'Personable curbside car guard in navy workwear and a high-visibility vest.',
  }),
  'joburg-driver': npc({
    id: 'joburg-driver', displayName: 'Zane Daniels', age: 39, sex: 'male', role: 'driver', district: 'Johannesburg', archetype: 'commuter-driver',
    description: 'Everyday Coloured South African commuter in dusty blue and charcoal.',
  }),
};
