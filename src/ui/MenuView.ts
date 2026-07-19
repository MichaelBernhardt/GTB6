import type { MissionChoice } from '../systems/MissionSystem';
import type { CheatSettings, GameSettings } from '../types';
import { clampPercent, formatMoney, reputationLabel, type CheatWeaponEntry, type DrinkCatalogEntry, type LoadingState, type MainMenuSummary, type MenuScreen, type ShopArmourEntry, type ShopCatalogEntry } from './UIModels';
import { inebriationLabel, INEBRIATION_MAX } from '../core/DrinkRules';

export class MenuView {
  screen: MenuScreen = 'none';
  constructor(readonly root: HTMLElement) { root.id = 'menu'; root.setAttribute('aria-live', 'off'); }

  hide(): void { this.root.classList.remove('is-visible'); this.root.setAttribute('aria-hidden', 'true'); this.screen = 'none'; }

  loading(state: LoadingState): void {
    if (this.screen !== 'loading') {
      this.set('loading', `<section class="menu-card menu-card--loading" aria-busy="true"><p class="eyebrow">CITY SERVICES</p><h2>Getting Joburg ready</h2><div class="loading-progress" role="progressbar" aria-label="Loading game" aria-valuemin="0" aria-valuemax="100"><i data-loading-bar></i></div><div class="loading-progress__status"><strong data-loading-label></strong><output data-loading-percent></output></div><small data-loading-detail></small></section>`);
    }
    const progress = clampPercent(state.progress);
    const meter = this.root.querySelector<HTMLElement>('.loading-progress');
    meter?.setAttribute('aria-valuenow', String(progress)); meter?.setAttribute('aria-valuetext', `${state.label}, ${progress}%`);
    const bar = this.root.querySelector<HTMLElement>('[data-loading-bar]'); if (bar) bar.style.width = `${progress}%`;
    const label = this.root.querySelector<HTMLElement>('[data-loading-label]'); if (label) label.textContent = state.label;
    const percent = this.root.querySelector<HTMLOutputElement>('[data-loading-percent]'); if (percent) percent.textContent = `${progress}%`;
    const detail = this.root.querySelector<HTMLElement>('[data-loading-detail]'); if (detail) detail.textContent = state.detail;
  }

  assetFailed(retry: () => void): void {
    this.set('asset-failed', `<section class="menu-card menu-card--loading menu-card--asset-failed"><p class="eyebrow">CITY SERVICES</p><h2>Required model failed to load</h2><p>The city stays closed until the player, Blender taxis, and tree library are ready.</p><button class="action-primary" data-action="retry-assets">Retry</button></section>`);
    this.bind('[data-action="retry-assets"]', retry);
  }

  main(summary: MainMenuSummary, actions: { start: (fresh: boolean) => void; online: (name: string) => void; controls: () => void }): void {
    const progress = summary.hasSave ? `<aside class="save-ticket"><small>LAST SEEN IN JOZI</small><b>${formatMoney(summary.money)}</b><span>${summary.completedMissions}/${summary.totalMissions} jobs · ${reputationLabel(summary.reputation)} CBD</span></aside>` : '<aside class="save-ticket save-ticket--empty"><small>NEW ARRIVAL</small><span>No city history yet. Make the first move.</span></aside>';
    this.set('main', `<section class="main-menu">
      <div class="main-menu__copy"><p class="eyebrow">A JOZI STORY · V2</p><h1><span>GROOT</span><span>THEFT</span><strong>BAKKIE</strong></h1><p class="main-menu__lede">Make a name across five districts where every robot is a suggestion and every action leaves a mark.</p>
      <div class="menu-actions"><button class="action-primary" data-action="${summary.hasSave ? 'continue' : 'new'}"><span>${summary.hasSave ? 'Continue solo' : 'Enter Joburg solo'}</span><kbd>ENTER</kbd></button>${summary.hasSave ? '<button data-action="new">Start fresh</button>' : ''}<div class="online-entry"><input data-online-name maxlength="24" value="${this.savedOnlineName()}" aria-label="Online display name" placeholder="Display name"><button data-action="online">Enter global world</button></div><button data-action="controls">Field guide</button></div></div>
      <div class="main-menu__rail">${progress}<div class="street-note"><b>LOAD SHEDDING</b><span>Included at no extra cost.</span></div></div>
      <footer>ORIGINAL PROCEDURAL OPEN-WORLD GAME <i></i> JOHANNESBURG<span class="main-menu__build"> · ${__BUILD_HASH__}</span></footer>
    </section>`);
    this.bind('[data-action="continue"]', () => actions.start(false)); this.bind('[data-action="new"]', () => actions.start(true));
    this.bind('[data-action="online"]', () => { const input = this.root.querySelector<HTMLInputElement>('[data-online-name]'); const name = input?.value.trim() || 'Player'; localStorage.setItem('groot-theft-bakkie-online-name', name); actions.online(name); });
    this.bind('[data-action="controls"]', actions.controls);
  }

  pause(settings: GameSettings, actions: { resume: () => void; restart: () => void; controls: () => void; cheats: () => void; reset: () => void; settings: (value: Partial<GameSettings>) => void }): void {
    this.set('pause', `<section class="menu-card menu-card--wide"><header><p class="eyebrow">GAME PAUSED</p><h2>Take a breather.</h2><span>Joburg will still be here.</span></header><div class="pause-grid"><nav class="pause-nav"><button class="action-primary" data-action="resume">Resume</button><button data-action="restart">Respawn</button><button data-action="controls">Field guide</button><button data-action="cheats">Testing tools</button></nav><form class="settings" aria-label="Game settings">
      <label><span>Master volume <output>${Math.round(settings.masterVolume * 100)}%</output></span><input data-setting="volume" type="range" min="0" max="1" step="0.05" value="${settings.masterVolume}"></label>
      <label><span>Mouse sensitivity</span><input data-setting="sensitivity" type="range" min="0.001" max="0.006" step="0.0005" value="${settings.mouseSensitivity}"></label>
      <label><span>Graphics quality</span><select data-setting="quality"><option value="ultra" ${settings.quality === 'ultra' ? 'selected' : ''}>Ultra</option><option value="high" ${settings.quality === 'high' ? 'selected' : ''}>High</option><option value="medium" ${settings.quality === 'medium' ? 'selected' : ''}>Medium</option><option value="low" ${settings.quality === 'low' ? 'selected' : ''}>Low</option><option value="potato" ${settings.quality === 'potato' ? 'selected' : ''}>Skorokoro (runs on hope)</option></select></label>
      <label class="toggle"><input data-setting="fps" type="checkbox" ${settings.showFps ? 'checked' : ''}><span>Show performance display</span></label>${document.body.classList.contains('is-touch') ? `<label class="toggle"><input data-setting="touchswap" type="checkbox" ${settings.touchSwapSides ? 'checked' : ''}><span>Swap control sides</span></label>` : ''}</form></div><button class="danger-link" data-action="reset">Reset all saved progress</button></section>`);
    this.bind('[data-action="resume"]', actions.resume); this.bind('[data-action="restart"]', actions.restart); this.bind('[data-action="controls"]', actions.controls); this.bind('[data-action="cheats"]', actions.cheats); this.bind('[data-action="reset"]', actions.reset);
    const volume = this.root.querySelector<HTMLInputElement>('[data-setting="volume"]'); volume?.addEventListener('input', () => { actions.settings({ masterVolume: Number(volume.value) }); const output = volume.closest('label')?.querySelector('output'); if (output) output.textContent = `${Math.round(Number(volume.value) * 100)}%`; });
    this.root.querySelector<HTMLInputElement>('[data-setting="sensitivity"]')?.addEventListener('input', (event) => actions.settings({ mouseSensitivity: Number((event.target as HTMLInputElement).value) }));
    this.root.querySelector<HTMLSelectElement>('[data-setting="quality"]')?.addEventListener('change', (event) => actions.settings({ quality: (event.target as HTMLSelectElement).value as GameSettings['quality'] }));
    this.root.querySelector<HTMLInputElement>('[data-setting="fps"]')?.addEventListener('change', (event) => actions.settings({ showFps: (event.target as HTMLInputElement).checked }));
    this.root.querySelector<HTMLInputElement>('[data-setting="touchswap"]')?.addEventListener('change', (event) => actions.settings({ touchSwapSides: (event.target as HTMLInputElement).checked }));
  }

  controls(fromMain: boolean, back: () => void): void {
    const groups = [
      ['WASD', 'Move / drive'], ['MOUSE', 'Look / aim'], ['SHIFT', 'Sprint'], ['CTRL/RMB', 'Aim / drive-by'], ['SPACE', 'Jump / handbrake / chute'], ['E', 'Interact / vehicle'], ['Q', 'Take cover'], ['LMB', 'Fire / punch'], ['TAB', 'Weapon wheel'], ['SCROLL', 'Cycle weapons'], ['1—6', 'Select weapon'], ['R', 'Reload'], ['H', 'Use stim pack'], ['L', 'Torch (load shedding)'], ['ALT', 'Walk, don\'t run'], ['V', 'Camera view'], ['F', 'Mug / melee / recover'], ['T', 'Taxi duty'], ['Y', 'Sixty-Sekonds shift'], ['N / SHIFT+N', 'Next / previous radio'], ['G', 'Siren (police car)'], ['PGUP/PGDN', 'Minimap zoom'], ['M', 'City map'], ['ESC', 'Pause'], ['~', 'Console'],
    ];
    this.set('controls', `<section class="menu-card menu-card--guide"><header><p class="eyebrow">FIELD GUIDE</p><h2>Know the streets.</h2><span>${fromMain ? 'The essentials before you enter.' : 'Controls for foot and vehicle.'}</span></header><div class="control-grid">${groups.map(([key, label]) => `<div><kbd>${key}</kbd><span>${label}</span></div>`).join('')}</div><button class="action-primary" data-action="back">Back</button></section>`); this.bind('[data-action="back"]', back);
  }

  shop(entries: ShopCatalogEntry[], balance: number, actions: { buy: (id: ShopCatalogEntry['id']) => void; ammo: (id: ShopCatalogEntry['id']) => void; armour: () => void; leave: () => void }, armour?: ShopArmourEntry): void {
    const rows = entries.map((entry) => entry.owned
      ? `<button class="shop-row" data-ammo="${entry.id}" ${entry.canRefill ? '' : 'disabled'}><span><b>${entry.name}</b><small>Reserve ${entry.reserve}</small></span><em>${entry.ammoFull ? 'FULL' : formatMoney(entry.ammoPrice)}</em></button>`
      : `<button class="shop-row" data-buy="${entry.id}" ${entry.canBuy ? '' : 'disabled'}><span><b>${entry.name}</b><small>${entry.canBuy ? 'Available now' : 'Not enough cash'}</small></span><em>${formatMoney(entry.price)}</em></button>`).join('');
    const armourRow = armour ? `<button class="shop-row" data-action="armour" ${armour.canBuy ? '' : 'disabled'}><span><b>BODY ARMOUR</b><small>${armour.full ? 'Fully plated already' : 'Soaks damage before health'}</small></span><em>${armour.full ? 'FULL' : formatMoney(armour.price)}</em></button>` : '';
    this.set('shop', `<section class="menu-card menu-card--shop"><header><p class="eyebrow">JOZI ARMS · CBD</p><h2>Choose your insurance.</h2><div class="balance-stamp">ON HAND <b>${formatMoney(balance)}</b></div></header><div class="shop-list">${rows}${armourRow}</div><button data-action="leave">Leave the counter</button></section>`);
    for (const entry of entries) { this.bind(`[data-buy="${entry.id}"]`, () => actions.buy(entry.id)); this.bind(`[data-ammo="${entry.id}"]`, () => actions.ammo(entry.id)); } this.bind('[data-action="armour"]', actions.armour); this.bind('[data-action="leave"]', actions.leave);
  }

  bottle(storeName: string, entries: DrinkCatalogEntry[], balance: number, inebriation: number, actions: { buy: (id: DrinkCatalogEntry['id']) => void; leave: () => void }): void {
    const rows = entries.map((entry) => {
      const potency = entry.potency < 0 ? `SOBER-UP ${entry.potency}` : `+${entry.potency} DOP`;
      const reason = entry.canBuy ? entry.note : entry.potency < 0 ? 'Stone-cold sober already' : 'Not enough cash';
      return `<button class="shop-row" data-drink="${entry.id}" ${entry.canBuy ? '' : 'disabled'}><span><b>${entry.name}</b><small>${reason}</small></span><em>${formatMoney(entry.price)}<i class="drink-potency">${potency}</i></em></button>`;
    }).join('');
    const meter = Math.round((Math.max(0, Math.min(INEBRIATION_MAX, inebriation)) / INEBRIATION_MAX) * 100);
    const tag = inebriationLabel(inebriation);
    const gauge = `<div class="drunk-gauge${tag?.warn ? ' is-babalas' : ''}"><span>DOP LEVEL</span><div class="drunk-gauge__track"><i style="width:${meter}%"></i></div><b>${tag ? tag.text : 'STONE SOBER'}</b></div>`;
    this.set('bottle', `<section class="menu-card menu-card--shop"><header><p class="eyebrow">${storeName.toUpperCase()} · LIQUOR</p><h2>Wet your whistle.</h2><div class="balance-stamp">ON HAND <b>${formatMoney(balance)}</b></div></header>${gauge}<div class="shop-list">${rows}</div><button data-action="leave">Cap it off &amp; leave</button></section>`);
    for (const entry of entries) this.bind(`[data-drink="${entry.id}"]`, () => actions.buy(entry.id));
    this.bind('[data-action="leave"]', actions.leave);
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
  private savedOnlineName(): string { return (localStorage.getItem('groot-theft-bakkie-online-name') ?? 'Player').replace(/["<>]/g, '').slice(0, 24); }
  private bind(selector: string, callback: () => void): void { this.root.querySelector(selector)?.addEventListener('click', callback); }
}
