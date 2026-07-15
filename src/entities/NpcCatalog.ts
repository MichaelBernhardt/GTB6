export const NPC_CHARACTER_IDS = [
  'braamfontein-creative',
  'sandton-professional',
  'rosebank-athlete',
  'melville-creative',
] as const;

export type NpcCharacterId = typeof NPC_CHARACTER_IDS[number];

export interface NpcCharacterMetadata {
  id: NpcCharacterId;
  displayName: string;
  age: number;
  district: 'Braamfontein' | 'Sandton' | 'Rosebank' | 'Melville';
  archetype: 'creative' | 'professional' | 'athlete';
  description: string;
  modelUrl: string;
}

export const NPC_CATALOG: Readonly<Record<NpcCharacterId, NpcCharacterMetadata>> = {
  'braamfontein-creative': {
    id: 'braamfontein-creative', displayName: 'Lerato', age: 27, district: 'Braamfontein', archetype: 'creative',
    description: 'Black South African creative in fitted rust streetwear, dark teal trousers and braids.',
    modelUrl: '/models/npcs/braamfontein-creative.glb',
  },
  'sandton-professional': {
    id: 'sandton-professional', displayName: 'Priya', age: 30, district: 'Sandton', archetype: 'professional',
    description: 'South African Indian professional in deep-plum office-glam tailoring and long hair.',
    modelUrl: '/models/npcs/sandton-professional.glb',
  },
  'rosebank-athlete': {
    id: 'rosebank-athlete', displayName: 'Mia', age: 25, district: 'Rosebank', archetype: 'athlete',
    description: 'Coloured South African athlete in fitted coral and graphite sportswear with a ponytail.',
    modelUrl: '/models/npcs/rosebank-athlete.glb',
  },
  'melville-creative': {
    id: 'melville-creative', displayName: 'Hannah', age: 29, district: 'Melville', archetype: 'creative',
    description: 'White South African creative in an ochre weekend top, dark denim and a chestnut bob.',
    modelUrl: '/models/npcs/melville-creative.glb',
  },
};
