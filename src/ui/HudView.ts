import { inebriationLabel, INEBRIATION_MAX } from '../core/DrinkRules';
import { clampPercent, formatMoney, objectiveProgress, reputationLabel, type HudState } from './UIModels';

const required = <T extends Element>(root: ParentNode, selector: string): T => {
  const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing HUD element: ${selector}`); return element;
};

// Avoid invalidating layout/style for values that did not change. Most HUD data is stable for many
// frames (clock minute, ammo, health, prompt), but update() runs at render cadence.
const setText = (element: Element, value: string): void => { if (element.textContent !== value) element.textContent = value; };
const setHidden = (element: HTMLElement, hidden: boolean): void => { if (element.hidden !== hidden) element.hidden = hidden; };
const setWidth = (element: HTMLElement, width: string): void => { if (element.style.width !== width) element.style.width = width; };
const setAttribute = (element: Element, name: string, value: string): void => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };

export class HudView {
  private district: HTMLElement;
  private clock: HTMLElement;
  private reputation: HTMLElement;
  private health: HTMLElement;
  private healthFill: HTMLElement;
  private healthBox: HTMLElement;
  private armourBox: HTMLElement;
  private armour: HTMLElement;
  private armourFill: HTMLElement;
  private items: HTMLElement;
  private stims: HTMLElement;
  private chutes: HTMLElement;
  private cash: HTMLElement;
  private weaponName: HTMLElement;
  private ammo: HTMLElement;
  private reserve: HTMLElement;
  private reload: HTMLElement;
  private wantedContainer: HTMLElement;
  private wanted: HTMLElement[];
  private objective: HTMLElement;
  private objectiveName: HTMLElement;
  private objectiveText: HTMLElement;
  private objectiveMeta: HTMLElement;
  private objectiveFill: HTMLElement;
  private objectiveTrack: HTMLElement;
  private prompt: HTMLElement;
  private vehicle: HTMLElement;
  private vehicleName: HTMLElement;
  private vehicleSpeed: HTMLElement;
  private vehicleHealth: HTMLElement;
  private taxi: HTMLElement;
  private radio: HTMLElement;
  private fps: HTMLElement;
  private cheats: HTMLElement;
  private crosshair: HTMLElement;
  private scope: HTMLElement;
  private scopeZoom: HTMLElement;
  private drunkBox: HTMLElement;
  private drunkLabel: HTMLElement;
  private drunkFill: HTMLElement;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-scope" data-hud="scope" aria-hidden="true" hidden><div class="scope-lens"><i class="scope-mil-h"></i><i class="scope-mil-v"></i><span class="scope-dot"></span></div><b data-hud="scope-zoom"></b></div>
      <header class="hud-masthead" aria-label="Location and reputation">
        <div class="hud-wordmark"><span>GROOT THEFT</span><strong>BAKKIE</strong></div>
        <div class="hud-location"><span data-hud="district"></span><b data-hud="clock"></b><em data-hud="reputation"></em></div>
      </header>
      <section class="hud-status" aria-label="Player status">
        <div class="hud-wanted" data-hud="wanted" aria-label="Wanted level 0 of 5">${Array.from({ length: 5 }, () => '<i aria-hidden="true">★</i>').join('')}</div>
        <div class="hud-health" role="progressbar" aria-label="Health" aria-valuemin="0" aria-valuemax="100"><span data-hud="health-fill"></span><b data-hud="health"></b></div>
        <div class="hud-cash"><small>ON HAND</small><b data-hud="cash"></b></div>
        <div class="hud-armour" data-hud="armour-box" role="progressbar" aria-label="Armour" aria-valuemin="0" aria-valuemax="100" hidden><span data-hud="armour-fill"></span><b data-hud="armour"></b></div>
        <div class="hud-weapon"><small data-hud="weapon-name"></small><b data-hud="ammo"></b><span data-hud="reserve"></span><em data-hud="reload">RELOADING</em></div>
        <div class="hud-drunk" data-hud="drunk" role="status" aria-label="Inebriation" hidden><i aria-hidden="true">🍺</i><b data-hud="drunk-label"></b><span class="hud-drunk__track"><em data-hud="drunk-fill"></em></span></div>
      </section>
      <section class="hud-objective" data-hud="objective" aria-label="Current objective">
        <div><small data-hud="objective-name"></small><span data-hud="objective-meta"></span></div>
        <strong data-hud="objective-text"></strong><div class="hud-objective-track" data-hud="objective-track" role="progressbar" aria-label="Objective progress" aria-valuemin="0" aria-valuemax="100"><i data-hud="objective-fill"></i></div>
      </section>
      <section class="hud-vehicle" data-hud="vehicle" aria-label="Vehicle telemetry"><small data-hud="vehicle-name"></small><div><b data-hud="vehicle-speed"></b><span>KM/H</span></div><em data-hud="vehicle-health"></em><i class="hud-radio" data-hud="radio" role="status"></i><i class="hud-taxi" data-hud="taxi" role="status"></i></section>
      <div class="hud-prompt" data-hud="prompt" role="status"></div>
      <div class="hud-items" data-hud="items" aria-label="Carried items" hidden><i data-hud="stims" hidden></i><i data-hud="chutes" hidden></i></div>
      <div class="hud-fps" data-hud="fps"></div><div class="hud-cheats" data-hud="cheats">CHEATS ACTIVE</div>
      <div class="hud-crosshair" data-hud="crosshair" aria-hidden="true" hidden><i></i></div>`;
    this.district = required(root, '[data-hud="district"]'); this.clock = required(root, '[data-hud="clock"]'); this.reputation = required(root, '[data-hud="reputation"]');
    this.health = required(root, '[data-hud="health"]'); this.healthFill = required(root, '[data-hud="health-fill"]'); this.cash = required(root, '[data-hud="cash"]');
    this.healthBox = required(root, '.hud-health');
    this.armourBox = required(root, '[data-hud="armour-box"]'); this.armour = required(root, '[data-hud="armour"]'); this.armourFill = required(root, '[data-hud="armour-fill"]');
    this.items = required(root, '[data-hud="items"]'); this.stims = required(root, '[data-hud="stims"]'); this.chutes = required(root, '[data-hud="chutes"]');
    this.weaponName = required(root, '[data-hud="weapon-name"]'); this.ammo = required(root, '[data-hud="ammo"]'); this.reserve = required(root, '[data-hud="reserve"]'); this.reload = required(root, '[data-hud="reload"]');
    this.wantedContainer = required(root, '[data-hud="wanted"]'); this.wanted = Array.from(root.querySelectorAll<HTMLElement>('.hud-wanted i'));
    this.objective = required(root, '[data-hud="objective"]'); this.objectiveName = required(root, '[data-hud="objective-name"]'); this.objectiveText = required(root, '[data-hud="objective-text"]'); this.objectiveMeta = required(root, '[data-hud="objective-meta"]'); this.objectiveFill = required(root, '[data-hud="objective-fill"]'); this.objectiveTrack = required(root, '[data-hud="objective-track"]');
    this.prompt = required(root, '[data-hud="prompt"]'); this.vehicle = required(root, '[data-hud="vehicle"]'); this.vehicleName = required(root, '[data-hud="vehicle-name"]'); this.vehicleSpeed = required(root, '[data-hud="vehicle-speed"]'); this.vehicleHealth = required(root, '[data-hud="vehicle-health"]'); this.radio = required(root, '[data-hud="radio"]'); this.taxi = required(root, '[data-hud="taxi"]');
    this.fps = required(root, '[data-hud="fps"]'); this.cheats = required(root, '[data-hud="cheats"]'); this.crosshair = required(root, '[data-hud="crosshair"]');
    this.scope = required(root, '[data-hud="scope"]'); this.scopeZoom = required(root, '[data-hud="scope-zoom"]');
    this.drunkBox = required(root, '[data-hud="drunk"]'); this.drunkLabel = required(root, '[data-hud="drunk-label"]'); this.drunkFill = required(root, '[data-hud="drunk-fill"]');
  }

  update(state: HudState): void {
    const health = clampPercent(state.health); setText(this.district, state.district); setText(this.clock, state.clock); setText(this.reputation, state.reputation ? reputationLabel(state.reputation) : '');
    setHidden(this.reputation, !state.reputation); setText(this.health, `${health}`); setWidth(this.healthFill, `${health}%`);
    setAttribute(this.healthBox, 'aria-valuenow', String(health));
    const armour = clampPercent(state.armour); setHidden(this.armourBox, armour <= 0);
    if (armour > 0) { setText(this.armour, `${armour}`); setWidth(this.armourFill, `${armour}%`); setAttribute(this.armourBox, 'aria-valuenow', String(armour)); }
    const tag = inebriationLabel(state.inebriation); setHidden(this.drunkBox, !tag);
    if (tag) {
      setText(this.drunkLabel, tag.text); setWidth(this.drunkFill, `${clampPercent((state.inebriation / INEBRIATION_MAX) * 100)}%`);
      this.drunkBox.classList.toggle('is-babalas', tag.warn);
    }
    setHidden(this.stims, state.stims <= 0); if (state.stims > 0) setText(this.stims, `STIM ×${state.stims} · H`);
    setHidden(this.chutes, state.parachutes <= 0); if (state.parachutes > 0) setText(this.chutes, `CHUTE ×${state.parachutes}`);
    setHidden(this.items, state.stims <= 0 && state.parachutes <= 0);
    setText(this.cash, formatMoney(state.money)); setText(this.weaponName, state.weaponName);
    setText(this.ammo, state.melee ? '—' : String(state.ammo)); setText(this.reserve, state.melee ? '' : `/ ${state.reserve}`); setHidden(this.reload, !state.reloading);
    this.wanted.forEach((star, index) => star.classList.toggle('is-hot', index < state.wanted)); setAttribute(this.wantedContainer, 'aria-label', `Wanted level ${state.wanted} of 5`);
    setHidden(this.objective, !state.objective);
    if (state.objective) {
      setText(this.objectiveName, state.objective.missionName); setText(this.objectiveText, state.objective.text);
      const bits: string[] = [];
      if (state.objective.required && state.objective.progress !== undefined) bits.push(`${state.objective.progress}/${state.objective.required}`);
      if (state.objective.remainingSeconds) bits.push(`${Math.ceil(state.objective.remainingSeconds)} SEC`);
      setText(this.objectiveMeta, bits.join(' · ')); const progress = objectiveProgress(state.objective); setWidth(this.objectiveFill, `${progress ?? 0}%`); setHidden(this.objectiveTrack, progress === undefined); setAttribute(this.objectiveTrack, 'aria-valuenow', String(progress ?? 0));
    }
    setText(this.prompt, state.prompt); setHidden(this.prompt, !state.prompt);
    setHidden(this.vehicle, !state.vehicle);
    if (state.vehicle) {
      setText(this.vehicleName, state.vehicle.name); setText(this.vehicleSpeed, String(Math.round(state.vehicle.speedKph))); setText(this.vehicleHealth, `${Math.ceil(state.vehicle.health)}% VEHICLE`);
      setHidden(this.radio, !state.vehicle.radio); if (state.vehicle.radio) setText(this.radio, state.vehicle.radio);
      const job = state.vehicle.courier ?? state.vehicle.taxi; setHidden(this.taxi, !job);
      if (job) { setText(this.taxi, job.text); this.taxi.classList.toggle('is-on', job.available); }
    }
    setText(this.fps, `${Math.round(state.fps)} FPS · A* ${state.navCalls}/s ${state.navMs.toFixed(1)}ms · X ${state.position.x.toFixed(1)} Y ${state.position.y.toFixed(1)} Z ${state.position.z.toFixed(1)}`); setHidden(this.fps, !state.settings.showFps); setHidden(this.cheats, !state.cheatsOn); setHidden(this.crosshair, !state.crosshair);
    setHidden(this.scope, !state.scope); if (state.scope) setText(this.scopeZoom, state.scope.zoom);
  }
}
