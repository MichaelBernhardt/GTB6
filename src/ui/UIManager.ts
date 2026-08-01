import type { WeaponId } from '../config';
import type { DrinkId } from '../core/DrinkRules';
import type { MissionChoice } from '../systems/MissionSystem';
import type { CheatSettings, GameSettings } from '../types';
import type { RoadPoint } from '../world/City';
import { easeProgress, isStalled, workingDots } from './BootProgress';
import { ConsoleView } from './ConsoleView';
import { HudView } from './HudView';
import { MapView, type MapViewFrame } from './MapView';
import { MenuView } from './MenuView';
import { MinimapView, type MapMarker, type MapPoint } from './MinimapView';
import { TOAST_MS, toastVisibleAt, type CheatWeaponEntry, type DrinkCatalogEntry, type FeatureMenuView, type HudState, type LoadingState, type MainMenuSummary, type MenuScreen, type NotificationTone, type ShopArmourEntry, type ShopCatalogEntry, type ShopLockpickEntry, type WheelEntry } from './UIModels';

export type { CheatWeaponEntry, FeatureHudEntry, FeatureMenuView, HudState, MainMenuSummary, ShopArmourEntry, ShopCatalogEntry, ShopLockpickEntry, WheelEntry } from './UIModels';

/** Height each bar takes at full coverage, as a fraction of the viewport: a 16:9 frame masked to
 *  2.39:1 Scope loses (1 - (16/9)/2.39) of its height, half above and half below. A real ratio,
 *  because "black stripes" and "the film has started" are two different signals. */
const LETTERBOX_COVERAGE = (1 - (16 / 9) / 2.39) / 2;

export class UIManager {
  root = document.createElement('div');
  hud = document.createElement('div');
  toast = document.createElement('div');
  wheel = document.createElement('div');
  vignette = document.createElement('div');
  fade = document.createElement('div');
  letterbox = document.createElement('div');
  private letterboxHint = document.createElement('b');
  private hudView: HudView;
  private menuView: MenuView;
  private minimapView = new MinimapView();
  private consoleView = new ConsoleView();
  private mapView = new MapView();
  private toastDeadline = 0; // wall-clock ms (performance.now domain) — never frame-counted
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private controlsFromMain = false;
  private loadingTarget?: LoadingState;
  private loadingDisplay = 0;
  private loadingLastReal = 0;
  private loadingLastTick = 0;
  private loadingTicker?: ReturnType<typeof setInterval>;
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
  onBuyLockpick?: () => void;
  onBuyDrink?: (id: DrinkId) => void;
  onMissionChoice?: (id: MissionChoice['id']) => void;
  /** The ONE callback every feature menu routes through — bound once in Game.bindUI(). */
  onFeatureMenuAction?: (featureId: string, actionId: string) => void;
  onSafehouseSave?: () => void;
  onSafehouseSleep?: () => void;
  onConsoleCommand?: (text: string) => void;
  onConsoleClose?: () => void;
  onMapClose?: () => void;
  onMapWaypoint?: (x: number, z: number) => void;
  onMapWaypointClear?: () => void;

  constructor() {
    this.root.id = 'ui'; this.hud.id = 'hud'; this.toast.id = 'toast'; this.toast.setAttribute('role', 'status'); this.toast.setAttribute('aria-live', 'polite'); this.toast.setAttribute('aria-atomic', 'true');
    this.wheel.id = 'weapon-wheel'; this.vignette.id = 'vignette'; this.fade.id = 'fade';
    this.letterbox.id = 'letterbox'; this.letterbox.setAttribute('aria-hidden', 'true');
    const topBar = document.createElement('i'); const bottomBar = document.createElement('i');
    bottomBar.append(this.letterboxHint); this.letterbox.append(topBar, bottomBar);
    this.menuView = new MenuView(document.createElement('div')); this.hudView = new HudView(this.hud);
    this.consoleView.onSubmit = (text) => this.onConsoleCommand?.(text); this.consoleView.onClose = () => this.onConsoleClose?.();
    this.mapView.onClose = () => this.onMapClose?.();
    this.mapView.onWaypoint = (x, z) => this.onMapWaypoint?.(x, z);
    this.mapView.onWaypointClear = () => this.onMapWaypointClear?.();
    this.root.append(this.vignette, this.hud, this.minimapView.canvas, this.toast, this.wheel, this.letterbox, this.mapView.root, this.consoleView.root, this.menuView.root, this.fade); document.body.append(this.root); this.showLoading();
  }

  get consoleOpen(): boolean { return this.consoleView.open; }
  openConsole(): void { this.consoleView.show(); }
  closeConsole(): void { this.consoleView.hide(); }
  consolePrint(lines: string[]): void { this.consoleView.print(lines); }

  get mapOpen(): boolean { return this.mapView.open; }
  openMap(frame: MapViewFrame): void { this.mapView.show(frame); }
  closeMap(): void { this.mapView.hide(); }
  updateMap(frame: MapViewFrame): void { this.mapView.update(frame); }
  navigateMenu(direction: -1 | 1, horizontal = false): void { this.menuView.navigate(direction, horizontal); }
  activateMenuControl(): void { this.menuView.activateFocused(); }

  update(state: HudState): void {
    this.hudView.update(state); if (!toastVisibleAt(performance.now(), this.toastDeadline)) this.toast.classList.remove('is-visible');
  }

  /**
   * CINEMA BARS. `amount` is 0..1 of full 2.39:1 coverage and the CALLER owns the easing, so a scene
   * slides them in, holds them, and slides them out on its own clock rather than a CSS transition
   * that cannot be interrupted by a skip. Raising them also stands the HUD and the radar down: a
   * fuel gauge inside a letterbox is the one thing that would break the shot.
   */
  setLetterbox(amount: number, hint = ''): void {
    const clamped = Math.max(0, Math.min(1, amount));
    const up = clamped > 0.001;
    this.letterbox.style.setProperty('--bar', `${(clamped * LETTERBOX_COVERAGE * 100).toFixed(2)}vh`);
    this.letterbox.classList.toggle('is-visible', up);
    this.root.classList.toggle('is-cinema', up);
    if (this.letterboxHint.textContent !== hint) this.letterboxHint.textContent = hint;
  }

  damageFlash(): void { this.vignette.classList.remove('is-flashing'); void this.vignette.offsetWidth; this.vignette.classList.add('is-flashing'); }
  screenFade(): void { this.fade.classList.add('is-active'); clearTimeout(this.fadeTimer); this.fadeTimer = setTimeout(() => this.fade.classList.remove('is-active'), 620); }
  drawMap(x: number, z: number, heading: number, roads: RoadPoint[][], markers: MapMarker[], police: MapPoint[], hostiles: MapPoint[] = [], zoom?: number, route: readonly MapPoint[] = []): void {
    this.minimapView.draw(x, z, heading, roads, markers, police, hostiles, zoom, route);
  }

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
    this.toast.className = `is-visible tone-${resolved}`; this.toastDeadline = performance.now() + TOAST_MS;
  }
  hideMenu(): void { this.menuView.hide(); }
  /** Which menu screen is up right now — so a purchase shared by two counters can re-render the one
   *  the player is actually standing at (the lock pick sells at Jozi Arms AND the bottle stores). */
  menuScreen(): MenuScreen { return this.menuView.screen; }

  back(): boolean {
    if (this.menuView.screen === 'shop' || this.menuView.screen === 'bottle' || this.menuView.screen === 'safehouse' || this.menuView.screen === 'feature') { this.onResume?.(); return true; }
    if (this.menuView.screen === 'choice') return true;
    if (this.menuView.screen === 'controls') { if (this.controlsFromMain || !this.lastSettings) this.showMainMenu(); else this.showPause(this.lastSettings); return true; }
    if (this.menuView.screen === 'cheats') { if (this.lastSettings) this.showPause(this.lastSettings); else this.showMainMenu(); return true; }
    if (this.menuView.screen === 'pause') { this.onResume?.(); return true; }
    return false;
  }

  /** Real boot checkpoints land here; a ticker eases the visible bar toward the latest one so
   *  it always moves between checkpoints — honestly (see BootProgress: it never arrives early,
   *  and after 8s without real progress the detail line flips to "still working…" instead). */
  showLoading(state: LoadingState = { progress: 0, label: 'Starting city systems', detail: 'Preparing the renderer and Johannesburg map.' }): void {
    const previous = this.loadingTarget;
    if (!previous || previous.progress !== state.progress || previous.label !== state.label || previous.detail !== state.detail) this.loadingLastReal = performance.now();
    this.loadingTarget = state;
    this.menuView.loading({ ...state, progress: this.loadingDisplay }); // claim the screen at the current eased value; the ticker animates from here
    if (this.loadingTicker === undefined) { this.loadingLastTick = performance.now(); this.loadingTicker = setInterval(() => this.tickLoading(), 120); }
  }

  private tickLoading(): void {
    const target = this.loadingTarget;
    if (!target) return;
    if (this.menuView.screen !== 'loading') { // another screen took over: stop driving
      clearInterval(this.loadingTicker); this.loadingTicker = undefined; this.loadingTarget = undefined;
      return;
    }
    const now = performance.now();
    this.loadingDisplay = easeProgress(this.loadingDisplay, target.progress, now - this.loadingLastTick);
    this.loadingLastTick = now;
    const stalled = isStalled(now, this.loadingLastReal);
    this.menuView.loading({ progress: this.loadingDisplay, label: target.label, detail: stalled ? `Still working${workingDots(now)} — ${target.detail}` : target.detail });
  }
  showAssetFailure(retry: () => void): void { this.menuView.assetFailed(retry); }
  showMainMenu(summary?: MainMenuSummary): void {
    if (summary) this.mainSummary = summary;
    this.menuView.main(this.mainSummary, { start: (fresh) => this.onStart?.(fresh), online: (name) => this.onOnline?.(name), controls: () => this.showControls(true) });
  }
  showPause(settings: GameSettings): void {
    this.lastSettings = settings; this.menuView.pause(settings, { resume: () => this.onResume?.(), restart: () => this.onRestart?.(), controls: () => this.showControls(), cheats: () => this.onShowCheats?.(), reset: () => this.onResetSave?.(), settings: (value) => this.onSettings?.(value) });
  }
  showControls(fromMain = false): void { this.controlsFromMain = fromMain; this.menuView.controls(fromMain, () => this.back()); }
  showShop(entries: ShopCatalogEntry[], balance: number, armour?: ShopArmourEntry, lockpick?: ShopLockpickEntry): void { this.menuView.shop(entries, balance, { buy: (id) => this.onBuyWeapon?.(id), ammo: (id) => this.onBuyAmmo?.(id), armour: () => this.onBuyArmour?.(), lockpick: () => this.onBuyLockpick?.(), leave: () => this.back() }, armour, lockpick); }
  showBottleStore(name: string, entries: DrinkCatalogEntry[], balance: number, inebriation: number, lockpick?: ShopLockpickEntry): void { this.menuView.bottle(name, entries, balance, inebriation, { buy: (id) => this.onBuyDrink?.(id), lockpick: () => this.onBuyLockpick?.(), leave: () => this.back() }, lockpick); }
  showMissionChoice(title: string, choices: MissionChoice[]): void { this.menuView.choice(title, choices, (id) => this.onMissionChoice?.(id)); }
  /** Host-owned feature screen: one show, one action callback, for every feature there will ever be. */
  showFeatureMenu(view: FeatureMenuView): void { this.menuView.feature(view, { choose: (actionId) => this.onFeatureMenuAction?.(view.featureId, actionId), leave: () => this.back() }); }
  showSafehouse(name: string, sleepHours: number): void { this.menuView.safehouse(name, sleepHours, { save: () => this.onSafehouseSave?.(), sleep: () => this.onSafehouseSleep?.(), leave: () => this.back() }); }
  showCheats(weapons: CheatWeaponEntry[], cheats: CheatSettings): void {
    this.menuView.cheats(weapons, cheats, { weapon: (id) => { this.onGiveWeapon?.(id); this.onShowCheats?.(); }, maxAmmo: () => this.onMaxAmmo?.(), toggle: (value) => this.onCheats?.(value), back: () => this.back() });
  }
}
