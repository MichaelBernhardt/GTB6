import type { MissionSystem } from '../systems/MissionSystem';
import type { Vehicle } from '../entities/Vehicle';
import type { GameSettings } from '../types';
import type { RoadPoint } from '../world/City';

export interface HudState {
  health: number; money: number; ammo: number; reserve: number; wanted: number; district: string; prompt: string;
  vehicle?: Vehicle; mission: MissionSystem; fps: number; settings: GameSettings;
}

export class UIManager {
  root = document.createElement('div');
  hud = document.createElement('div');
  menu = document.createElement('div');
  toast = document.createElement('div');
  minimap = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private toastTimer = 0;
  onStart?: (fresh: boolean) => void;
  onResume?: () => void;
  onRestart?: () => void;
  onResetSave?: () => void;
  onSettings?: (settings: Partial<GameSettings>) => void;

  constructor() {
    this.root.id = 'ui'; this.hud.id = 'hud'; this.menu.id = 'menu'; this.toast.id = 'toast'; this.minimap.id = 'minimap'; this.minimap.width = 210; this.minimap.height = 210;
    const context = this.minimap.getContext('2d'); if (!context) throw new Error('Canvas unavailable'); this.context = context;
    this.root.append(this.hud, this.minimap, this.toast, this.menu); document.body.append(this.root); this.showLoading();
  }

  update(state: HudState): void {
    const objective = state.mission.objective;
    const timer = state.mission.remainingTime > 0 ? ` <b>${Math.ceil(state.mission.remainingTime)}s</b>` : '';
    const progress = objective?.required ? ` <span>${state.mission.progress}/${objective.required}</span>` : '';
    this.hud.innerHTML = `
      <div class="brand">SAN <strong>CORDOVA</strong><small>${state.district}</small></div>
      <div class="status"><div class="health"><i style="width:${state.health}%"></i><span>HEALTH ${Math.ceil(state.health)}</span></div><div class="cash">$${state.money.toLocaleString()}</div></div>
      <div class="weapon"><span>9MM</span><b>${state.ammo}</b><small>/ ${state.reserve}</small></div>
      <div class="wanted">${Array.from({ length: 5 }, (_, i) => `<i class="${i < state.wanted ? 'hot' : ''}">★</i>`).join('')}</div>
      ${state.vehicle ? `<div class="vehicle"><span>${state.vehicle.spec.name}</span><b>${Math.round(Math.abs(state.vehicle.speed) * 3.6)}</b><small>KM/H</small><em>${Math.ceil(state.vehicle.health)}%</em></div>` : ''}
      ${objective ? `<div class="objective"><small>${state.mission.active?.name}</small><span>${objective.text}${progress}${timer}</span></div>` : ''}
      ${state.prompt ? `<div class="prompt">${state.prompt}</div>` : ''}
      ${state.settings.showFps ? `<div class="fps">${Math.round(state.fps)} FPS</div>` : ''}
      <div class="crosshair">+</div>`;
    this.toastTimer = Math.max(0, this.toastTimer - 1 / 60); if (this.toastTimer === 0) this.toast.classList.remove('visible');
  }

  drawMap(x: number, z: number, heading: number, roads: RoadPoint[][], markers: Array<{ x: number; z: number; color: string }>, police: Array<{ x: number; z: number }>): void {
    const ctx = this.context; const size = this.minimap.width; const scale = 0.27;
    ctx.clearRect(0, 0, size, size); ctx.fillStyle = '#35443d'; ctx.fillRect(0, 0, size, size); ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(heading); ctx.translate(-x * scale, -z * scale);
    ctx.strokeStyle = '#a4aaa7'; ctx.lineWidth = 19 * scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const road of roads) { const first = road[0]; if (!first) continue; ctx.beginPath(); ctx.moveTo(first.x * scale, first.z * scale); for (const point of road.slice(1)) ctx.lineTo(point.x * scale, point.z * scale); ctx.stroke(); }
    for (const marker of markers) { ctx.fillStyle = marker.color; ctx.beginPath(); ctx.arc(marker.x * scale, marker.z * scale, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#62aaff'; for (const unit of police) { ctx.fillRect(unit.x * scale - 3, unit.z * scale - 3, 6, 6); }
    ctx.restore(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(size / 2, size / 2 - 10); ctx.lineTo(size / 2 - 7, size / 2 + 8); ctx.lineTo(size / 2 + 7, size / 2 + 8); ctx.closePath(); ctx.fill();
  }

  notify(title: string, detail = '', success = true): void { this.toast.innerHTML = `<strong>${title}</strong><span>${detail}</span>`; this.toast.className = `visible ${success ? 'success' : 'failure'}`; this.toastTimer = 4; }
  hideMenu(): void { this.menu.classList.remove('visible'); }
  showLoading(): void { this.menu.innerHTML = `<div class="menu-panel"><p class="kicker">SAN CORDOVA</p><h2>Building the city...</h2></div>`; this.menu.classList.add('visible'); }
  showMainMenu(): void {
    this.menu.innerHTML = `<div class="menu-panel"><p class="kicker">A SAN CORDOVA STORY</p><h1>NEON<br><strong>RECKONING</strong></h1><p>Make a name across five districts where every shortcut has a consequence.</p><div class="menu-actions"><button id="continue">Enter San Cordova</button><button id="new">New game</button><button id="help">Controls</button></div><small>Original procedural open-world game</small></div>`;
    this.menu.classList.add('visible'); this.bind('#continue', () => this.onStart?.(false)); this.bind('#new', () => this.onStart?.(true)); this.bind('#help', () => this.showControls(true));
  }
  showPause(settings: GameSettings): void {
    this.menu.innerHTML = `<div class="menu-panel compact"><p class="kicker">GAME PAUSED</p><h2>San Cordova</h2><button id="resume">Resume</button><button id="restart">Respawn</button><button id="controls">Controls</button><label>Master volume <input id="volume" type="range" min="0" max="1" step="0.05" value="${settings.masterVolume}"></label><label>Mouse sensitivity <input id="sensitivity" type="range" min="0.001" max="0.006" step="0.0005" value="${settings.mouseSensitivity}"></label><label>Graphics quality <select id="quality"><option value="high" ${settings.quality === 'high' ? 'selected' : ''}>High</option><option value="low" ${settings.quality === 'low' ? 'selected' : ''}>Low</option></select></label><label class="toggle"><input id="fpsToggle" type="checkbox" ${settings.showFps ? 'checked' : ''}> Performance display</label><button id="reset" class="danger">Reset saved progress</button></div>`;
    this.menu.classList.add('visible'); this.bind('#resume', () => this.onResume?.()); this.bind('#restart', () => this.onRestart?.()); this.bind('#controls', () => this.showControls()); this.bind('#reset', () => this.onResetSave?.());
    this.menu.querySelector('#volume')?.addEventListener('input', (e) => this.onSettings?.({ masterVolume: Number((e.target as HTMLInputElement).value) }));
    this.menu.querySelector('#sensitivity')?.addEventListener('input', (e) => this.onSettings?.({ mouseSensitivity: Number((e.target as HTMLInputElement).value) }));
    this.menu.querySelector('#quality')?.addEventListener('change', (e) => this.onSettings?.({ quality: (e.target as HTMLSelectElement).value as GameSettings['quality'] }));
    this.menu.querySelector('#fpsToggle')?.addEventListener('change', (e) => this.onSettings?.({ showFps: (e.target as HTMLInputElement).checked }));
  }
  showControls(fromMain = false): void {
    this.menu.innerHTML = `<div class="menu-panel compact controls"><p class="kicker">FIELD GUIDE</p><h2>Controls</h2><div><kbd>WASD</kbd><span>Move / drive</span><kbd>Mouse</kbd><span>Orbit / aim</span><kbd>Shift</kbd><span>Sprint</span><kbd>Space</kbd><span>Jump / handbrake</span><kbd>E</kbd><span>Interact / vehicle</span><kbd>LMB</kbd><span>Aim and fire</span><kbd>R</kbd><span>Reload</span><kbd>F</kbd><span>Mug / melee · vehicle recovery</span><kbd>Esc</kbd><span>Pause</span><kbd>Backquote</kbd><span>Performance</span></div><button id="back">Back</button></div>`;
    this.menu.classList.add('visible'); this.bind('#back', () => { if (fromMain) this.showMainMenu(); else this.onResume?.(); });
  }
  private bind(selector: string, callback: () => void): void { this.menu.querySelector(selector)?.addEventListener('click', callback); }
}
