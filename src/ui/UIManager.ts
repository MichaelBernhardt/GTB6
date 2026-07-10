import type { MissionSystem } from '../systems/MissionSystem';
import type { Vehicle } from '../entities/Vehicle';
import type { WeaponId } from '../config';
import type { CheatSettings, GameSettings } from '../types';
import type { RoadPoint } from '../world/City';

export interface HudState {
  health: number; money: number; weaponName: string; melee: boolean; ammo: number; reserve: number; reloading: boolean; wanted: number; district: string; clock: string; prompt: string;
  vehicle?: Vehicle; mission: MissionSystem; fps: number; settings: GameSettings; cheatsOn: boolean;
}

export interface CheatWeaponEntry { id: WeaponId; name: string; owned: boolean; }

export interface WheelEntry { name: string; ammo: string; highlighted: boolean; equipped: boolean; locked: boolean; }

export interface ShopCatalogEntry { id: WeaponId; name: string; owned: boolean; price: number; ammoPrice: number; reserve: number; ammoFull: boolean; canBuy: boolean; canRefill: boolean; }

export class UIManager {
  root = document.createElement('div');
  hud = document.createElement('div');
  menu = document.createElement('div');
  toast = document.createElement('div');
  wheel = document.createElement('div');
  minimap = document.createElement('canvas');
  vignette = document.createElement('div');
  fade = document.createElement('div');
  private context: CanvasRenderingContext2D;
  private toastTimer = 0;
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private screen: 'none' | 'main' | 'pause' | 'controls' | 'cheats' | 'shop' = 'none';
  private controlsFromMain = false;
  private lastSettings?: GameSettings;
  onStart?: (fresh: boolean) => void;
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

  constructor() {
    this.root.id = 'ui'; this.hud.id = 'hud'; this.menu.id = 'menu'; this.toast.id = 'toast'; this.wheel.id = 'weapon-wheel'; this.minimap.id = 'minimap'; this.minimap.width = 210; this.minimap.height = 210;
    const context = this.minimap.getContext('2d'); if (!context) throw new Error('Canvas unavailable'); this.context = context;
    this.vignette.id = 'vignette'; this.fade.id = 'fade';
    this.root.append(this.vignette, this.hud, this.minimap, this.toast, this.wheel, this.menu, this.fade); document.body.append(this.root); this.showLoading();
  }

  update(state: HudState): void {
    const objective = state.mission.objective;
    const timer = state.mission.remainingTime > 0 ? ` <b>${Math.ceil(state.mission.remainingTime)}s</b>` : '';
    const progress = objective?.required ? ` <span>${state.mission.progress}/${objective.required}</span>` : '';
    this.hud.innerHTML = `
      <div class="brand">SAN <strong>CORDOVA</strong><small>${state.district} &middot; ${state.clock}</small></div>
      <div class="status"><div class="health"><i style="width:${state.health}%"></i><span>HEALTH ${Math.ceil(state.health)}</span></div><div class="cash">$${state.money.toLocaleString()}</div></div>
      <div class="weapon"><span>${state.weaponName}</span>${state.melee ? '<b>&mdash;</b>' : `<b>${state.ammo}</b><small>/ ${state.reserve}</small>${state.reloading ? '<em>RELOADING</em>' : ''}`}</div>
      <div class="wanted">${Array.from({ length: 5 }, (_, i) => `<i class="${i < state.wanted ? 'hot' : ''}">★</i>`).join('')}</div>
      ${state.vehicle ? `<div class="vehicle"><span>${state.vehicle.spec.name}</span><b>${Math.round(Math.abs(state.vehicle.speed) * 3.6)}</b><small>KM/H</small><em>${Math.ceil(state.vehicle.health)}%</em></div>` : ''}
      ${objective ? `<div class="objective"><small>${state.mission.active?.name}</small><span>${objective.text}${progress}${timer}</span></div>` : ''}
      ${state.prompt ? `<div class="prompt">${state.prompt}</div>` : ''}
      ${state.settings.showFps ? `<div class="fps">${Math.round(state.fps)} FPS</div>` : ''}
      ${state.cheatsOn ? '<div class="cheats-flag">CHEATS ON</div>' : ''}
      <div class="crosshair">+</div>`;
    this.toastTimer = Math.max(0, this.toastTimer - 1 / 60); if (this.toastTimer === 0) this.toast.classList.remove('visible');
  }

  damageFlash(): void { this.vignette.classList.remove('flash'); void this.vignette.offsetWidth; this.vignette.classList.add('flash'); }

  screenFade(): void {
    this.fade.classList.add('active');
    clearTimeout(this.fadeTimer); this.fadeTimer = setTimeout(() => this.fade.classList.remove('active'), 620);
  }

  drawMap(x: number, z: number, heading: number, roads: RoadPoint[][], markers: Array<{ x: number; z: number; color: string }>, police: Array<{ x: number; z: number }>, hostiles: Array<{ x: number; z: number }> = []): void {
    const ctx = this.context; const size = this.minimap.width; const scale = 0.27;
    ctx.clearRect(0, 0, size, size); ctx.fillStyle = '#35443d'; ctx.fillRect(0, 0, size, size); ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(heading - Math.PI); ctx.translate(-x * scale, -z * scale);
    ctx.strokeStyle = '#a4aaa7'; ctx.lineWidth = 19 * scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const road of roads) { const first = road[0]; if (!first) continue; ctx.beginPath(); ctx.moveTo(first.x * scale, first.z * scale); for (const point of road.slice(1)) ctx.lineTo(point.x * scale, point.z * scale); ctx.stroke(); }
    for (const marker of markers) { ctx.fillStyle = marker.color; ctx.beginPath(); ctx.arc(marker.x * scale, marker.z * scale, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#62aaff'; for (const unit of police) { ctx.fillRect(unit.x * scale - 3, unit.z * scale - 3, 6, 6); }
    ctx.fillStyle = '#e5443a'; for (const foe of hostiles) { ctx.beginPath(); ctx.arc(foe.x * scale, foe.z * scale, 3.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(size / 2, size / 2 - 10); ctx.lineTo(size / 2 - 7, size / 2 + 8); ctx.lineTo(size / 2 + 7, size / 2 + 8); ctx.closePath(); ctx.fill();
  }

  showWeaponWheel(entries: WheelEntry[]): void {
    const radius = 140; const step = (Math.PI * 2) / Math.max(1, entries.length);
    this.wheel.innerHTML = entries.map((entry, index) => {
      const x = Math.sin(index * step) * radius; const y = -Math.cos(index * step) * radius;
      return `<div class="slice ${entry.highlighted ? 'hot' : ''} ${entry.equipped ? 'equipped' : ''} ${entry.locked ? 'locked' : ''}" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px"><span>${entry.name}</span><small>${entry.locked ? 'LOCKED' : entry.ammo}</small></div>`;
    }).join('') + '<div class="hub">WEAPONS</div>';
    this.wheel.classList.add('visible');
  }
  hideWeaponWheel(): void { this.wheel.classList.remove('visible'); }

  notify(title: string, detail = '', success = true): void { this.toast.innerHTML = `<strong>${title}</strong><span>${detail}</span>`; this.toast.className = `visible ${success ? 'success' : 'failure'}`; this.toastTimer = 4; }
  hideMenu(): void { this.menu.classList.remove('visible'); this.screen = 'none'; }

  back(): boolean {
    if (this.screen === 'shop') { this.onResume?.(); return true; }
    if (this.screen === 'controls' || this.screen === 'cheats') {
      if ((this.screen === 'controls' && this.controlsFromMain) || !this.lastSettings) this.showMainMenu(); else this.showPause(this.lastSettings);
      return true;
    }
    if (this.screen === 'pause') { this.onResume?.(); return true; }
    return false;
  }
  showLoading(): void { this.menu.innerHTML = `<div class="menu-panel"><p class="kicker">SAN CORDOVA</p><h2>Building the city...</h2></div>`; this.menu.classList.add('visible'); }
  showMainMenu(): void {
    this.menu.innerHTML = `<div class="menu-panel"><p class="kicker">A SAN CORDOVA STORY</p><h1>NEON<br><strong>RECKONING</strong></h1><p>Make a name across five districts where every shortcut has a consequence.</p><div class="menu-actions"><button id="continue">Enter San Cordova</button><button id="new">New game</button><button id="help">Controls</button></div><small>Original procedural open-world game</small></div>`;
    this.menu.classList.add('visible'); this.screen = 'main'; this.bind('#continue', () => this.onStart?.(false)); this.bind('#new', () => this.onStart?.(true)); this.bind('#help', () => this.showControls(true));
  }
  showPause(settings: GameSettings): void {
    this.menu.innerHTML = `<div class="menu-panel compact"><p class="kicker">GAME PAUSED</p><h2>San Cordova</h2><button id="resume">Resume</button><button id="restart">Respawn</button><button id="controls">Controls</button><button id="cheats">Cheats</button><label>Master volume <input id="volume" type="range" min="0" max="1" step="0.05" value="${settings.masterVolume}"></label><label>Mouse sensitivity <input id="sensitivity" type="range" min="0.001" max="0.006" step="0.0005" value="${settings.mouseSensitivity}"></label><label>Graphics quality <select id="quality"><option value="high" ${settings.quality === 'high' ? 'selected' : ''}>High</option><option value="medium" ${settings.quality === 'medium' ? 'selected' : ''}>Medium</option><option value="low" ${settings.quality === 'low' ? 'selected' : ''}>Low</option></select></label><label class="toggle"><input id="fpsToggle" type="checkbox" ${settings.showFps ? 'checked' : ''}> Performance display</label><button id="reset" class="danger">Reset saved progress</button></div>`;
    this.menu.classList.add('visible'); this.screen = 'pause'; this.lastSettings = settings; this.bind('#resume', () => this.onResume?.()); this.bind('#restart', () => this.onRestart?.()); this.bind('#controls', () => this.showControls()); this.bind('#cheats', () => this.onShowCheats?.()); this.bind('#reset', () => this.onResetSave?.());
    this.menu.querySelector('#volume')?.addEventListener('input', (e) => this.onSettings?.({ masterVolume: Number((e.target as HTMLInputElement).value) }));
    this.menu.querySelector('#sensitivity')?.addEventListener('input', (e) => this.onSettings?.({ mouseSensitivity: Number((e.target as HTMLInputElement).value) }));
    this.menu.querySelector('#quality')?.addEventListener('change', (e) => this.onSettings?.({ quality: (e.target as HTMLSelectElement).value as GameSettings['quality'] }));
    this.menu.querySelector('#fpsToggle')?.addEventListener('change', (e) => this.onSettings?.({ showFps: (e.target as HTMLInputElement).checked }));
  }
  showControls(fromMain = false): void {
    this.menu.innerHTML = `<div class="menu-panel compact controls"><p class="kicker">FIELD GUIDE</p><h2>Controls</h2><div><kbd>WASD</kbd><span>Move / drive</span><kbd>Mouse</kbd><span>Orbit / aim</span><kbd>Shift</kbd><span>Sprint</span><kbd>Space</kbd><span>Jump / handbrake</span><kbd>E</kbd><span>Interact / vehicle</span><kbd>LMB</kbd><span>Aim and fire / punch</span><kbd>Tab</kbd><span>Hold for weapon wheel</span><kbd>Scroll</kbd><span>Cycle weapons</span><kbd>1-5</kbd><span>Select weapon</span><kbd>R</kbd><span>Reload</span><kbd>V</kbd><span>Cycle camera view</span><kbd>F</kbd><span>Mug / melee · vehicle recovery</span><kbd>Esc</kbd><span>Pause</span><kbd>Backquote</kbd><span>Performance</span></div><button id="back">Back</button></div>`;
    this.menu.classList.add('visible'); this.screen = 'controls'; this.controlsFromMain = fromMain; this.bind('#back', () => this.back());
  }
  showShop(entries: ShopCatalogEntry[], balance: number): void {
    const rows = entries.map((entry) => entry.owned
      ? `<button data-ammo="${entry.id}" ${entry.canRefill ? '' : 'disabled'}>${entry.name} &middot; ${entry.ammoFull ? 'ammo full' : `ammo refill $${entry.ammoPrice.toLocaleString()}`}<small>reserve ${entry.reserve}</small></button>`
      : `<button data-buy="${entry.id}" ${entry.canBuy ? '' : 'disabled'}>${entry.name} &middot; $${entry.price.toLocaleString()}<small>${entry.canBuy ? 'buy' : 'not enough cash'}</small></button>`).join('');
    this.menu.innerHTML = `<div class="menu-panel compact shop"><p class="kicker">CORDOVA ARMS</p><h2>Weapons Counter</h2><p class="balance">Cash on hand <b>$${balance.toLocaleString()}</b></p>${rows}<button id="leave">Leave the store</button></div>`;
    this.menu.classList.add('visible'); this.screen = 'shop';
    for (const entry of entries) {
      this.bind(`[data-buy="${entry.id}"]`, () => this.onBuyWeapon?.(entry.id));
      this.bind(`[data-ammo="${entry.id}"]`, () => this.onBuyAmmo?.(entry.id));
    }
    this.bind('#leave', () => this.back());
  }

  showCheats(weapons: CheatWeaponEntry[], cheats: CheatSettings): void {
    this.menu.innerHTML = `<div class="menu-panel compact"><p class="kicker">TESTING TOOLS</p><h2>Cheats</h2>${weapons.map((weapon) => `<button data-weapon="${weapon.id}">${weapon.name} &middot; ${weapon.owned ? 'top up ammo' : 'give'}</button>`).join('')}<button id="max-ammo">Max ammo (all weapons)</button><label class="toggle"><input id="cheat-fastrun" type="checkbox" ${cheats.fastRun ? 'checked' : ''}> Fast run</label><label class="toggle"><input id="cheat-bigjump" type="checkbox" ${cheats.bigJump ? 'checked' : ''}> Big jump</label><label class="toggle"><input id="cheat-invulnerable" type="checkbox" ${cheats.invulnerable ? 'checked' : ''}> Invulnerable</label><button id="back">Back</button></div>`;
    this.menu.classList.add('visible'); this.screen = 'cheats';
    for (const weapon of weapons) this.bind(`[data-weapon="${weapon.id}"]`, () => { this.onGiveWeapon?.(weapon.id); this.onShowCheats?.(); });
    this.bind('#max-ammo', () => this.onMaxAmmo?.()); this.bind('#back', () => this.back());
    this.menu.querySelector('#cheat-fastrun')?.addEventListener('change', (e) => this.onCheats?.({ fastRun: (e.target as HTMLInputElement).checked }));
    this.menu.querySelector('#cheat-bigjump')?.addEventListener('change', (e) => this.onCheats?.({ bigJump: (e.target as HTMLInputElement).checked }));
    this.menu.querySelector('#cheat-invulnerable')?.addEventListener('change', (e) => this.onCheats?.({ invulnerable: (e.target as HTMLInputElement).checked }));
  }
  private bind(selector: string, callback: () => void): void { this.menu.querySelector(selector)?.addEventListener('click', callback); }
}
