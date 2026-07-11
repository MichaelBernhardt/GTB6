import type { MissionChoice } from '../systems/MissionSystem';
import type { CheatSettings, GameSettings } from '../types';
import { formatMoney, reputationLabel, type CheatWeaponEntry, type MainMenuSummary, type MenuScreen, type ShopCatalogEntry } from './UIModels';

export class MenuView {
  screen: MenuScreen = 'none';
  constructor(readonly root: HTMLElement) { root.id = 'menu'; root.setAttribute('aria-live', 'off'); }

  hide(): void { this.root.classList.remove('is-visible'); this.root.setAttribute('aria-hidden', 'true'); this.screen = 'none'; }

  loading(): void {
    this.set('loading', `<section class="menu-card menu-card--loading"><p class="eyebrow">CITY SERVICES</p><h2>Building Jozi</h2><div class="loading-stripe" aria-label="Loading"></div><small>Robots, potholes and all.</small></section>`);
  }

  main(summary: MainMenuSummary, actions: { start: (fresh: boolean) => void; controls: () => void }): void {
    const progress = summary.hasSave ? `<aside class="save-ticket"><small>LAST SEEN IN JOZI</small><b>${formatMoney(summary.money)}</b><span>${summary.completedMissions}/${summary.totalMissions} jobs · ${reputationLabel(summary.reputation)} CBD</span></aside>` : '<aside class="save-ticket save-ticket--empty"><small>NEW ARRIVAL</small><span>No city history yet. Make the first move.</span></aside>';
    this.set('main', `<section class="main-menu">
      <div class="main-menu__copy"><p class="eyebrow">A JOZI STORY · V2</p><h1><span>GROOT</span><span>THEFT</span><strong>BAKKIE</strong></h1><p class="main-menu__lede">Make a name across five districts where every robot is a suggestion and every action leaves a mark.</p>
      <div class="menu-actions"><button class="action-primary" data-action="${summary.hasSave ? 'continue' : 'new'}"><span>${summary.hasSave ? 'Continue' : 'Enter Joburg'}</span><kbd>ENTER</kbd></button>${summary.hasSave ? '<button data-action="new">Start fresh</button>' : ''}<button data-action="controls">Field guide</button></div></div>
      <div class="main-menu__rail">${progress}<div class="street-note"><b>LOAD SHEDDING</b><span>Included at no extra cost.</span></div></div>
      <footer>ORIGINAL PROCEDURAL OPEN-WORLD GAME <i></i> JOHANNESBURG</footer>
    </section>`);
    this.bind('[data-action="continue"]', () => actions.start(false)); this.bind('[data-action="new"]', () => actions.start(true)); this.bind('[data-action="controls"]', actions.controls);
  }

  pause(settings: GameSettings, actions: { resume: () => void; restart: () => void; controls: () => void; cheats: () => void; reset: () => void; settings: (value: Partial<GameSettings>) => void }): void {
    this.set('pause', `<section class="menu-card menu-card--wide"><header><p class="eyebrow">GAME PAUSED</p><h2>Take a breather.</h2><span>Joburg will still be here.</span></header><div class="pause-grid"><nav class="pause-nav"><button class="action-primary" data-action="resume">Resume</button><button data-action="restart">Respawn</button><button data-action="controls">Field guide</button><button data-action="cheats">Testing tools</button></nav><form class="settings" aria-label="Game settings">
      <label><span>Master volume <output>${Math.round(settings.masterVolume * 100)}%</output></span><input data-setting="volume" type="range" min="0" max="1" step="0.05" value="${settings.masterVolume}"></label>
      <label><span>Mouse sensitivity</span><input data-setting="sensitivity" type="range" min="0.001" max="0.006" step="0.0005" value="${settings.mouseSensitivity}"></label>
      <label><span>Graphics quality</span><select data-setting="quality"><option value="high" ${settings.quality === 'high' ? 'selected' : ''}>High</option><option value="medium" ${settings.quality === 'medium' ? 'selected' : ''}>Medium</option><option value="low" ${settings.quality === 'low' ? 'selected' : ''}>Low</option></select></label>
      <label class="toggle"><input data-setting="fps" type="checkbox" ${settings.showFps ? 'checked' : ''}><span>Show performance display</span></label></form></div><button class="danger-link" data-action="reset">Reset all saved progress</button></section>`);
    this.bind('[data-action="resume"]', actions.resume); this.bind('[data-action="restart"]', actions.restart); this.bind('[data-action="controls"]', actions.controls); this.bind('[data-action="cheats"]', actions.cheats); this.bind('[data-action="reset"]', actions.reset);
    const volume = this.root.querySelector<HTMLInputElement>('[data-setting="volume"]'); volume?.addEventListener('input', () => { actions.settings({ masterVolume: Number(volume.value) }); const output = volume.closest('label')?.querySelector('output'); if (output) output.textContent = `${Math.round(Number(volume.value) * 100)}%`; });
    this.root.querySelector<HTMLInputElement>('[data-setting="sensitivity"]')?.addEventListener('input', (event) => actions.settings({ mouseSensitivity: Number((event.target as HTMLInputElement).value) }));
    this.root.querySelector<HTMLSelectElement>('[data-setting="quality"]')?.addEventListener('change', (event) => actions.settings({ quality: (event.target as HTMLSelectElement).value as GameSettings['quality'] }));
    this.root.querySelector<HTMLInputElement>('[data-setting="fps"]')?.addEventListener('change', (event) => actions.settings({ showFps: (event.target as HTMLInputElement).checked }));
  }

  controls(fromMain: boolean, back: () => void): void {
    const groups = [
      ['WASD', 'Move / drive'], ['MOUSE', 'Look / aim'], ['SHIFT', 'Sprint'], ['CTRL', 'Aim / drive-by'], ['SPACE', 'Jump / handbrake'], ['E', 'Interact / vehicle'], ['LMB', 'Fire / punch'], ['TAB', 'Weapon wheel'], ['SCROLL', 'Cycle weapons'], ['1—5', 'Select weapon'], ['R', 'Reload'], ['V', 'Camera view'], ['F', 'Mug / melee / recover'], ['G', 'Siren (police car)'], ['PGUP/PGDN', 'Minimap zoom'], ['ESC', 'Pause'], ['~', 'Console'],
    ];
    this.set('controls', `<section class="menu-card menu-card--guide"><header><p class="eyebrow">FIELD GUIDE</p><h2>Know the streets.</h2><span>${fromMain ? 'The essentials before you enter.' : 'Controls for foot and vehicle.'}</span></header><div class="control-grid">${groups.map(([key, label]) => `<div><kbd>${key}</kbd><span>${label}</span></div>`).join('')}</div><button class="action-primary" data-action="back">Back</button></section>`); this.bind('[data-action="back"]', back);
  }

  shop(entries: ShopCatalogEntry[], balance: number, actions: { buy: (id: ShopCatalogEntry['id']) => void; ammo: (id: ShopCatalogEntry['id']) => void; leave: () => void }): void {
    const rows = entries.map((entry) => entry.owned
      ? `<button class="shop-row" data-ammo="${entry.id}" ${entry.canRefill ? '' : 'disabled'}><span><b>${entry.name}</b><small>Reserve ${entry.reserve}</small></span><em>${entry.ammoFull ? 'FULL' : formatMoney(entry.ammoPrice)}</em></button>`
      : `<button class="shop-row" data-buy="${entry.id}" ${entry.canBuy ? '' : 'disabled'}><span><b>${entry.name}</b><small>${entry.canBuy ? 'Available now' : 'Not enough cash'}</small></span><em>${formatMoney(entry.price)}</em></button>`).join('');
    this.set('shop', `<section class="menu-card menu-card--shop"><header><p class="eyebrow">JOZI ARMS · CBD</p><h2>Choose your insurance.</h2><div class="balance-stamp">ON HAND <b>${formatMoney(balance)}</b></div></header><div class="shop-list">${rows}</div><button data-action="leave">Leave the counter</button></section>`);
    for (const entry of entries) { this.bind(`[data-buy="${entry.id}"]`, () => actions.buy(entry.id)); this.bind(`[data-ammo="${entry.id}"]`, () => actions.ammo(entry.id)); } this.bind('[data-action="leave"]', actions.leave);
  }

  safehouse(name: string, sleepHours: number, actions: { save: () => void; sleep: () => void; leave: () => void }): void {
    this.set('safehouse', `<section class="menu-card"><header><p class="eyebrow">SAFEHOUSE · ${name.toUpperCase()}</p><h2>Home, sharp sharp.</h2><span>Saving or sleeping sets your wake-up spot to this door.</span></header><nav class="pause-nav">
      <button class="action-primary" data-action="save">Save game</button>
      <button data-action="sleep">Sleep &middot; skip ${sleepHours} hours, heal up</button>
      <button data-action="leave">Back to the street</button></nav></section>`);
    this.bind('[data-action="save"]', actions.save); this.bind('[data-action="sleep"]', actions.sleep); this.bind('[data-action="leave"]', actions.leave);
  }

  choice(title: string, choices: MissionChoice[], choose: (id: MissionChoice['id']) => void): void {
    this.set('choice', `<section class="menu-card menu-card--choice"><header><p class="eyebrow">THE CITY WILL REMEMBER</p><h2>${title}</h2><span>This decision cannot be undone.</span></header><div class="choice-grid">${choices.map((choice, index) => `<button data-choice="${choice.id}"><small>OPTION 0${index + 1}</small><b>${choice.label}</b><span>${choice.detail}</span><em>REWARD ${formatMoney(choice.reward)}</em></button>`).join('')}</div></section>`); for (const choice of choices) this.bind(`[data-choice="${choice.id}"]`, () => choose(choice.id));
  }

  cheats(weapons: CheatWeaponEntry[], cheats: CheatSettings, actions: { weapon: (id: CheatWeaponEntry['id']) => void; maxAmmo: () => void; toggle: (value: Partial<CheatSettings>) => void; back: () => void }): void {
    this.set('cheats', `<section class="menu-card menu-card--tools"><header><p class="eyebrow">TESTING TOOLS</p><h2>Break the rules.</h2><span>Cheats are shown on the HUD while active.</span></header><div class="tools-list">${weapons.map((weapon) => `<button data-weapon="${weapon.id}"><b>${weapon.name}</b><small>${weapon.owned ? 'Top up ammo' : 'Grant weapon'}</small></button>`).join('')}<button data-action="max-ammo"><b>All ammunition</b><small>Fill every owned weapon</small></button></div><div class="toggle-row"><label><input data-cheat="fastRun" type="checkbox" ${cheats.fastRun ? 'checked' : ''}> Fast run</label><label><input data-cheat="bigJump" type="checkbox" ${cheats.bigJump ? 'checked' : ''}> Big jump</label><label><input data-cheat="invulnerable" type="checkbox" ${cheats.invulnerable ? 'checked' : ''}> Invulnerable</label></div><button data-action="back">Back</button></section>`);
    for (const weapon of weapons) this.bind(`[data-weapon="${weapon.id}"]`, () => actions.weapon(weapon.id)); this.bind('[data-action="max-ammo"]', actions.maxAmmo); this.bind('[data-action="back"]', actions.back);
    for (const key of ['fastRun', 'bigJump', 'invulnerable'] as const) this.root.querySelector<HTMLInputElement>(`[data-cheat="${key}"]`)?.addEventListener('change', (event) => actions.toggle({ [key]: (event.target as HTMLInputElement).checked }));
  }

  private set(screen: MenuScreen, html: string): void {
    this.screen = screen; this.root.innerHTML = html; this.root.className = `menu-overlay is-visible screen-${screen}`; this.root.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => this.root.querySelector<HTMLElement>('button:not(:disabled), input, select')?.focus());
  }
  private bind(selector: string, callback: () => void): void { this.root.querySelector(selector)?.addEventListener('click', callback); }
}
