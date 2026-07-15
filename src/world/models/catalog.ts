/**
 * Structure-model registry: name → builder + placement metadata. The placement pass consumes
 * this to scatter models deterministically: filter by zones, stamp maxFootprint (or the exact
 * per-build footprint returned by the builder), respect spacing, and feed each build's tiers
 * through City.tierToWorldCollider under a quarter-snapped heading.
 *
 * maxFootprint is the declared honest upper bound across every (seed, variant, size) — the
 * models test sweeps seeds and fails the catalog if any build ever exceeds it.
 */
import type { BuildOptions, BuiltModel, ModelDef } from './kit';
import { buildBarn, buildFarmhouse, buildFarmWorkerCottages, buildKraal, buildPadstal, buildSilo, buildTractorShed, buildWaterTower, buildWindpomp } from './rural';
import { buildBigBox, buildFillingStation, buildMixedUseCorner, buildOfficeBlock, buildParkingGarage, buildSpazaShop, buildStripMall } from './commercial';
import { buildContainerStack, buildFactory, buildLogisticsDepot, buildScrapyard, buildSubstation, buildTankFarm, buildWarehouse, buildWorkshopRow } from './industrial';
import { buildAblutions, buildBeachCafe, buildBeachLoungers, buildIceCreamKiosk, buildLifeguardTower, buildPavilion, buildPierKiosk, buildSurfShack } from './coastal';
import { buildApartmentBlock, buildFaceBrickHouse, buildRdpRow, buildSandtonVilla, buildSemiDetachedHouse, buildTinRoofHouse, buildTownhouseRow, buildWalkUpFlats } from './residentialSA';
import { buildBillboard, buildCellTower, buildChurch, buildCommunityHall, buildMosque, buildReservoir, buildSchool, buildSportsGround, buildTaxiRank } from './civic';
import { buildAcacia, buildAgave, buildAloe, buildBougainvillea, buildGum, buildHedgeUnit, buildJacaranda, buildLandmarkTree, buildPalm, buildPine, buildShadeTree, buildVeldGrass } from './foliage';

export type { BuildOptions, BuiltModel, ModelDef } from './kit';

export const MODEL_CATALOG: ModelDef[] = [
  // ---- Rural ----
  { name: 'farmhouse', category: 'rural', zones: ['rural', 'farm'], variants: 3, maxFootprint: { w: 23, d: 15 }, standable: false, spacing: 34, build: buildFarmhouse },
  { name: 'barn', category: 'rural', zones: ['rural', 'farm'], variants: 3, maxFootprint: { w: 19, d: 22 }, standable: false, spacing: 30, build: buildBarn },
  { name: 'water-tower', category: 'rural', zones: ['rural', 'farm', 'industrial'], variants: 2, maxFootprint: { w: 7, d: 7 }, standable: true, landmark: true, spacing: 120, build: buildWaterTower },
  { name: 'grain-silo', category: 'rural', zones: ['rural', 'farm'], variants: 3, maxFootprint: { w: 21, d: 8 }, standable: true, landmark: true, spacing: 90, build: buildSilo },
  { name: 'windpomp', category: 'rural', zones: ['rural', 'farm', 'veld'], variants: 2, maxFootprint: { w: 15, d: 9 }, standable: false, landmark: true, spacing: 100, build: buildWindpomp },
  { name: 'tractor-shed', category: 'rural', zones: ['rural', 'farm'], variants: 2, maxFootprint: { w: 15, d: 11 }, standable: false, spacing: 24, build: buildTractorShed },
  { name: 'kraal', category: 'rural', zones: ['rural', 'farm', 'veld'], variants: 2, maxFootprint: { w: 22, d: 13 }, standable: false, spacing: 30, build: buildKraal },
  { name: 'padstal', category: 'rural', zones: ['rural', 'roadside'], variants: 3, maxFootprint: { w: 12, d: 10 }, standable: false, spacing: 200, build: buildPadstal },
  { name: 'farm-worker-cottages', category: 'rural', zones: ['rural', 'farm'], variants: 3, maxFootprint: { w: 27, d: 13 }, standable: false, spacing: 30, build: buildFarmWorkerCottages },
  // ---- Commercial ----
  { name: 'strip-mall', category: 'commercial', zones: ['commercial', 'highstreet', 'suburb'], variants: 3, maxFootprint: { w: 36, d: 17 }, standable: true, spacing: 44, build: buildStripMall },
  { name: 'spaza-shop', category: 'commercial', zones: ['township', 'suburb', 'roadside'], variants: 3, maxFootprint: { w: 9, d: 8 }, standable: false, spacing: 26, build: buildSpazaShop },
  { name: 'filling-station', category: 'commercial', zones: ['roadside', 'commercial', 'highstreet'], variants: 3, maxFootprint: { w: 27, d: 24 }, standable: true, landmark: true, spacing: 260, build: buildFillingStation },
  { name: 'office-block', category: 'commercial', zones: ['commercial', 'highstreet'], variants: 3, maxFootprint: { w: 18, d: 15 }, standable: true, spacing: 26, build: buildOfficeBlock },
  { name: 'big-box', category: 'commercial', zones: ['commercial', 'industrial'], variants: 2, maxFootprint: { w: 44, d: 36 }, standable: true, landmark: true, spacing: 160, build: buildBigBox },
  { name: 'mixed-use-corner', category: 'commercial', zones: ['commercial', 'highstreet'], variants: 3, maxFootprint: { w: 21, d: 16 }, standable: true, spacing: 28, build: buildMixedUseCorner },
  { name: 'parking-garage', category: 'commercial', zones: ['commercial', 'highstreet'], variants: 2, maxFootprint: { w: 29, d: 20 }, standable: true, spacing: 90, build: buildParkingGarage },
  // ---- Industrial ----
  { name: 'warehouse', category: 'industrial', zones: ['industrial'], variants: 3, maxFootprint: { w: 25, d: 24 }, standable: false, spacing: 32, build: buildWarehouse },
  { name: 'factory-sawtooth', category: 'industrial', zones: ['industrial'], variants: 2, maxFootprint: { w: 30, d: 19 }, standable: true, landmark: true, spacing: 44, build: buildFactory },
  { name: 'tank-farm', category: 'industrial', zones: ['industrial', 'harbour'], variants: 3, maxFootprint: { w: 23, d: 23 }, standable: true, spacing: 40, build: buildTankFarm },
  { name: 'container-stack', category: 'industrial', zones: ['industrial', 'harbour'], variants: 3, maxFootprint: { w: 13, d: 8 }, standable: true, spacing: 14, build: buildContainerStack },
  { name: 'scrapyard', category: 'industrial', zones: ['industrial', 'township'], variants: 2, maxFootprint: { w: 23, d: 20 }, standable: true, spacing: 50, build: buildScrapyard },
  { name: 'substation', category: 'industrial', zones: ['industrial', 'roadside', 'suburb'], variants: 2, maxFootprint: { w: 16, d: 13 }, standable: false, spacing: 300, build: buildSubstation },
  { name: 'workshop-row', category: 'industrial', zones: ['industrial', 'township'], variants: 3, maxFootprint: { w: 29, d: 16 }, standable: true, spacing: 32, build: buildWorkshopRow },
  { name: 'logistics-depot', category: 'industrial', zones: ['industrial'], variants: 2, maxFootprint: { w: 37, d: 27 }, standable: true, spacing: 76, build: buildLogisticsDepot },
  // ---- Coastal ----
  { name: 'beach-cafe', category: 'coastal', zones: ['beach', 'promenade'], variants: 3, maxFootprint: { w: 19, d: 16 }, standable: true, spacing: 60, build: buildBeachCafe },
  { name: 'ice-cream-kiosk', category: 'coastal', zones: ['beach', 'promenade', 'park'], variants: 3, maxFootprint: { w: 8, d: 6 }, standable: false, spacing: 40, build: buildIceCreamKiosk },
  { name: 'ablutions', category: 'coastal', zones: ['beach', 'park'], variants: 2, maxFootprint: { w: 12, d: 7 }, standable: false, spacing: 120, build: buildAblutions },
  { name: 'pavilion', category: 'coastal', zones: ['promenade', 'park'], variants: 2, maxFootprint: { w: 15, d: 11 }, standable: true, spacing: 90, build: buildPavilion },
  { name: 'surf-shack', category: 'coastal', zones: ['beach'], variants: 3, maxFootprint: { w: 10, d: 7 }, standable: false, spacing: 36, build: buildSurfShack },
  { name: 'lifeguard-tower', category: 'coastal', zones: ['beach'], variants: 2, maxFootprint: { w: 5, d: 11 }, standable: true, landmark: true, spacing: 150, build: buildLifeguardTower },
  { name: 'beach-loungers', category: 'coastal', zones: ['beach'], variants: 3, maxFootprint: { w: 11, d: 11 }, standable: false, spacing: 16, build: buildBeachLoungers },
  { name: 'pier-kiosk', category: 'coastal', zones: ['promenade', 'pier'], variants: 2, maxFootprint: { w: 9, d: 6 }, standable: false, spacing: 30, build: buildPierKiosk },
  // ---- Residential (SA) ----
  { name: 'face-brick-house', category: 'residential', zones: ['suburb'], variants: 3, maxFootprint: { w: 22, d: 20 }, standable: false, spacing: 24, build: buildFaceBrickHouse },
  { name: 'townhouse-row', category: 'residential', zones: ['suburb'], variants: 2, maxFootprint: { w: 30, d: 18 }, standable: false, spacing: 34, build: buildTownhouseRow },
  { name: 'apartment-block', category: 'residential', zones: ['suburb', 'highstreet'], variants: 2, maxFootprint: { w: 23, d: 15 }, standable: true, spacing: 30, build: buildApartmentBlock },
  { name: 'tin-roof-house', category: 'residential', zones: ['township', 'rural'], variants: 3, maxFootprint: { w: 14, d: 14 }, standable: false, spacing: 16, build: buildTinRoofHouse },
  { name: 'sandton-villa', category: 'residential', zones: ['suburb', 'estate'], variants: 2, maxFootprint: { w: 26, d: 23 }, standable: true, spacing: 32, build: buildSandtonVilla },
  { name: 'semi-detached-house', category: 'residential', zones: ['suburb', 'township'], variants: 3, maxFootprint: { w: 24, d: 20 }, standable: false, spacing: 25, build: buildSemiDetachedHouse },
  { name: 'walk-up-flats', category: 'residential', zones: ['township', 'highstreet'], variants: 3, maxFootprint: { w: 24, d: 14 }, standable: true, spacing: 32, build: buildWalkUpFlats },
  { name: 'rdp-row', category: 'residential', zones: ['township'], variants: 3, maxFootprint: { w: 27, d: 12 }, standable: false, spacing: 22, build: buildRdpRow },
  // ---- Civic / extras ----
  { name: 'church', category: 'civic', zones: ['suburb', 'rural', 'township'], variants: 2, maxFootprint: { w: 14, d: 23 }, standable: false, landmark: true, spacing: 320, build: buildChurch },
  { name: 'mosque', category: 'civic', zones: ['suburb', 'township'], variants: 2, maxFootprint: { w: 18, d: 19 }, standable: false, landmark: true, spacing: 380, build: buildMosque },
  { name: 'school', category: 'civic', zones: ['suburb', 'township'], variants: 2, maxFootprint: { w: 22, d: 24 }, standable: false, spacing: 400, build: buildSchool },
  { name: 'taxi-rank', category: 'civic', zones: ['township', 'highstreet', 'commercial'], variants: 2, maxFootprint: { w: 25, d: 10 }, standable: true, spacing: 300, build: buildTaxiRank },
  { name: 'cell-tower', category: 'civic', zones: ['roadside', 'industrial', 'hill', 'suburb'], variants: 2, maxFootprint: { w: 9, d: 7 }, standable: false, landmark: true, spacing: 500, build: buildCellTower },
  { name: 'billboard', category: 'civic', zones: ['roadside', 'highway'], variants: 3, maxFootprint: { w: 11, d: 3 }, standable: false, spacing: 180, build: buildBillboard },
  { name: 'community-hall', category: 'civic', zones: ['township', 'suburb'], variants: 2, maxFootprint: { w: 21, d: 16 }, standable: false, spacing: 350, build: buildCommunityHall },
  { name: 'sports-ground', category: 'civic', zones: ['suburb', 'township', 'park'], variants: 2, maxFootprint: { w: 60, d: 40 }, standable: true, spacing: 420, build: buildSportsGround },
  { name: 'reservoir', category: 'civic', zones: ['hill', 'ridge', 'suburb'], variants: 2, maxFootprint: { w: 18, d: 18 }, standable: true, landmark: true, spacing: 600, build: buildReservoir },
  // ---- Foliage ----
  { name: 'jacaranda', category: 'foliage', zones: ['suburb', 'park', 'city', 'ridge'], variants: 2, maxFootprint: { w: 10.5, d: 10.5 }, standable: false, spacing: 8, build: buildJacaranda },
  { name: 'shade-tree', category: 'foliage', zones: ['suburb', 'park', 'city', 'ridge'], variants: 2, maxFootprint: { w: 12.5, d: 12.5 }, standable: false, spacing: 10, build: buildShadeTree },
  { name: 'gum', category: 'foliage', zones: ['suburb', 'park', 'city', 'ridge'], variants: 2, maxFootprint: { w: 7, d: 7 }, standable: false, spacing: 9, build: buildGum },
  { name: 'pine', category: 'foliage', zones: ['suburb', 'park', 'city', 'ridge'], variants: 2, maxFootprint: { w: 7, d: 7 }, standable: false, spacing: 7, build: buildPine },
  { name: 'acacia', category: 'foliage', zones: ['rural', 'veld', 'farm'], variants: 2, maxFootprint: { w: 8.5, d: 8.5 }, standable: false, spacing: 14, build: buildAcacia },
  { name: 'palm', category: 'foliage', zones: ['beach', 'promenade', 'coast'], variants: 2, maxFootprint: { w: 6, d: 6 }, standable: false, spacing: 6, build: buildPalm },
  { name: 'aloe', category: 'foliage', zones: ['rural', 'veld', 'farm', 'beach', 'promenade', 'coast'], variants: 2, maxFootprint: { w: 3.2, d: 3.2 }, standable: false, spacing: 4, build: buildAloe },
  { name: 'agave', category: 'foliage', zones: ['beach', 'promenade', 'coast'], variants: 2, maxFootprint: { w: 3.6, d: 3.6 }, standable: false, spacing: 5, build: buildAgave },
  { name: 'bougainvillea', category: 'foliage', zones: ['suburb'], variants: 2, maxFootprint: { w: 4.4, d: 4.4 }, standable: false, spacing: 8, build: buildBougainvillea },
  { name: 'veld-grass', category: 'foliage', zones: ['rural', 'veld', 'farm'], variants: 2, maxFootprint: { w: 2.2, d: 2.2 }, standable: false, spacing: 2.5, build: buildVeldGrass },
  { name: 'hedge-unit', category: 'foliage', zones: ['suburb', 'estate'], variants: 2, maxFootprint: { w: 4.8, d: 1.9 }, standable: false, spacing: 4, build: buildHedgeUnit },
  { name: 'landmark-tree', category: 'foliage', zones: ['park', 'ridge', 'city'], variants: 2, maxFootprint: { w: 17.5, d: 17.5 }, standable: false, landmark: true, spacing: 260, build: buildLandmarkTree },
];

export const MODEL_INDEX: ReadonlyMap<string, ModelDef> = new Map(MODEL_CATALOG.map((def) => [def.name, def]));

export function buildModel(name: string, seed: number, options?: BuildOptions): BuiltModel {
  const def = MODEL_INDEX.get(name);
  if (!def) throw new Error(`Unknown structure model: ${name}`);
  return def.build(seed, options);
}
