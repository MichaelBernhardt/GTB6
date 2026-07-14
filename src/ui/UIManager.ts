import type { WeaponId } from '../config';
import type { DrinkId } from '../core/DrinkRules';
import type { MissionChoice } from '../systems/MissionSystem';
import type { CheatSettings, GameSettings } from '../types';
import type { RoadPoint } from '../world/City';
import { ConsoleView } from './ConsoleView';
import { HudView } from './HudView';
import { MapView, type MapViewFrame } from './MapView';
import { MenuView } from './MenuView';
import { MinimapView, type MapMarker, type MapPoint } from './MinimapView';
import type { CheatWeaponEntry, DrinkCatalogEntry, HudState, MainMenuSummary, NotificationTone, ShopArmourEntry, ShopCatalogEntry, WheelEntry } from './UIModels';

export type { CheatWeaponEntry, HudState, MainMenuSummary, ShopArmourEntry, ShopCatalogEntry, WheelEntry } from './UIModels';

export class UIManager {
  root = document.createElement('div');
  hud = document.createElement('div');
  toast = document.createElement('div');
  wheel = document.createElement('div');
  vignette = document.createElement('div');
  fade = document.createElement('div');
  private hudView: HudView;
  private menuView: MenuView;
  private minimapView = new MinimapView();
  private consoleView = new ConsoleView();
  private mapView = new MapView();
  private toastTimer = 0;
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private controlsFromMain = false;
  private lastSettings?: GameSettings;
  private mainSummary: MainMenuSummary = { hasSave: false, money: 0, completedMissions: 0, totalMissions: 0, reputation: 'neutral' };
  onStart?: (fresh: boolean) => void;
  onOnline?: (name: string) => void;
  onResume?: () => void;
  onRestart?: () => void;
  onResetSave?: () => void;
  onSettings?: (settings: Partial<GameSettings>) => void;
  onShowCheats?: () => void;
  onGiveWeapon?: (id: WeaponId) => void;
  onMaxAmmo?: () => void;
  onCheats?: (cheats: Partial<CheatSettings>) => void;
  onBuyWeapon?: (id: WeaponId) => void;
  onBuyAmmo?: (id: WeaponId) => void;
  onBuyArmour?: () => void;
  onBuyDrink?: (id: DrinkId) => void;
  onMissionChoice?: (id: MissionChoice['id']) => void;
  onSafehouseSave?: () => void;
  onSafehouseSleep?: () => void;
  onConsoleCommand?: (text: string) => void;
  onConsoleClose?: () => void;
  onMapClose?: () => void;

  constructor() {
    this.root.id = 'ui'; this.hud.id = 'hud'; this.toast.id = 'toast'; this.toast.setAttribute('role', 'status'); this.toast.setAttribute('aria-live', 'polite'); this.toast.setAttribute('aria-atomic', 'true');
    this.wheel.id = 'weapon-wheel'; this.vignette.id = 'vignette'; this.fade.id = 'fade';
    this.menuView = new MenuView(document.createElement('div')); this.hudView = new HudView(this.hud);
    this.consoleView.onSubmit = (text) => this.onConsoleCommand?.(text); this.consoleView.onClose = () => this.onConsoleClose?.();
    this.mapView.onClose = () => this.onMapClose?.();
    this.root.append(this.vignette, this.hud, this.minimapView.canvas, this.toast, this.wheel, this.mapView.root, this.consoleView.root, this.menuView.root, this.fade); document.body.append(this.root); this.showLoading();
  }

  get consoleOpen(): boolean { return this.consoleView.open; }
  openConsole(): void { this.consoleView.show(); }
  closeConsole(): void { this.consoleView.hide(); }
  consolePrint(lines: string[]): void { this.consoleView.print(lines); }

  get mapOpen(): boolean { return this.mapView.open; }
  openMap(frame: MapViewFrame): void { this.mapView.show(frame); }
  closeMap(): void { this.mapView.hide(); }
  updateMap(frame: MapViewFrame): void { this.mapView.update(frame); }

  update(state: HudState): void {
    this.hudView.update(state); this.toastTimer = Math.max(0, this.toastTimer - 1 / 60); if (this.toastTimer === 0) this.toast.classList.remove('is-visible');
  }

  damageFlash(): void { this.vignette.classList.remove('is-flashing'); void this.vignette.offsetWidth; this.vignette.classList.add('is-flashing'); }
  screenFade(): void { this.fade.classList.add('is-active'); clearTimeout(this.fadeTimer); this.fadeTimer = setTimeout(() => this.fade.classList.remove('is-active'), 620); }
  drawMap(x: number, z: number, heading: number, roads: RoadPoint[][], markers: MapMarker[], police: MapPoint[], hostiles: MapPoint[] = [], zoom?: number): void { this.minimapView.draw(x, z, heading, roads, markers, police, hostiles, zoom); }

  showWeaponWheel(entries: WheelEntry[]): void {
    const radius = 150; const step = (Math.PI * 2) / Math.max(1, entries.length);
    this.wheel.innerHTML = entries.map((entry, index) => {
      const x = Math.sin(index * step) * radius; const y = -Math.cos(index * step) * radius;
      return `<div class="wheel-slice ${entry.highlighted ? 'is-hot' : ''} ${entry.equipped ? 'is-equipped' : ''} ${entry.locked ? 'is-locked' : ''}" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px"><span>${entry.name}</span><small>${entry.locked ? 'LOCKED' : entry.ammo}</small></div>`;
    }).join('') + '<div class="wheel-hub"><small>LOADOUT</small><b>WEAPONS</b></div>';
    this.wheel.classList.add('is-visible');
  }
  hideWeaponWheel(): void { this.wheel.classList.remove('is-visible'); }

  notify(title: string, detail = '', success = true, tone?: NotificationTone): void {
    const resolved = tone ?? (success ? 'success' : 'danger'); this.toast.innerHTML = `<small>${resolved === 'danger' ? 'CITY ALERT' : resolved === 'reputation' ? 'STREET WORD' : resolved === 'radio' ? 'JMPD DISPATCH' : resolved === 'music' ? 'NOW TUNED' : 'UPDATE'}</small><strong>${title}</strong><span>${detail}</span>`;
    this.toast.className = `is-visible tone-${resolved}`; this.toastTimer = 4;
  }
  hideMenu(): void { this.menuView.hide(); }

  back(): boolean {
    if (this.menuView.screen === 'shop' || this.menuView.screen === 'bottle' || this.menuView.screen === 'safehouse') { this.onResume?.(); return true; }
    if (this.menuView.screen === 'choice') return true;
    if (this.menuView.screen === 'controls') { if (this.controlsFromMain || !this.lastSettings) this.showMainMenu(); else this.showPause(this.lastSettings); return true; }
    if (this.menuView.screen === 'cheats') { if (this.lastSettings) this.showPause(this.lastSettings); else this.showMainMenu(); return true; }
    if (this.menuView.screen === 'pause') { this.onResume?.(); return true; }
    return false;
  }

  showLoading(): void { this.menuView.loading(); }
  showCharacterFailure(retry: () => void): void { this.menuView.characterFailed(retry); }
  showMainMenu(summary?: MainMenuSummary): void {
    if (summary) this.mainSummary = summary;
    this.menuView.main(this.mainSummary, { start: (fresh) => this.onStart?.(fresh), online: (name) => this.onOnline?.(name), controls: () => this.showControls(true) });
  }
  showPause(settings: GameSettings): void {
    this.lastSettings = settings; this.menuView.pause(settings, { resume: () => this.onResume?.(), restart: () => this.onRestart?.(), controls: () => this.showControls(), cheats: () => this.onShowCheats?.(), reset: () => this.onResetSave?.(), settings: (value) => this.onSettings?.(value) });
  }
  showControls(fromMain = false): void { this.controlsFromMain = fromMain; this.menuView.controls(fromMain, () => this.back()); }
  showShop(entries: ShopCatalogEntry[], balance: number, armour?: ShopArmourEntry): void { this.menuView.shop(entries, balance, { buy: (id) => this.onBuyWeapon?.(id), ammo: (id) => this.onBuyAmmo?.(id), armour: () => this.onBuyArmour?.(), leave: () => this.back() }, armour); }
  showBottleStore(name: string, entries: DrinkCatalogEntry[], balance: number, inebriation: number): void { this.menuView.bottle(name, entries, balance, inebriation, { buy: (id) => this.onBuyDrink?.(id), leave: () => this.back() }); }
  showMissionChoice(title: string, choices: MissionChoice[]): void { this.menuView.choice(title, choices, (id) => this.onMissionChoice?.(id)); }
  showSafehouse(name: string, sleepHours: number): void { this.menuView.safehouse(name, sleepHours, { save: () => this.onSafehouseSave?.(), sleep: () => this.onSafehouseSleep?.(), leave: () => this.back() }); }
  showCheats(weapons: CheatWeaponEntry[], cheats: CheatSettings): void {
    this.menuView.cheats(weapons, cheats, { weapon: (id) => { this.onGiveWeapon?.(id); this.onShowCheats?.(); }, maxAmmo: () => this.onMaxAmmo?.(), toggle: (value) => this.onCheats?.(value), back: () => this.back() });
  }
}
