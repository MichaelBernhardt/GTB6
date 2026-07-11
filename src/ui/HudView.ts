import { clampPercent, formatMoney, objectiveProgress, reputationLabel, type HudState } from './UIModels';

const required = <T extends Element>(root: ParentNode, selector: string): T => {
  const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing HUD element: ${selector}`); return element;
};

export class HudView {
  private district: HTMLElement;
  private clock: HTMLElement;
  private reputation: HTMLElement;
  private health: HTMLElement;
  private healthFill: HTMLElement;
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
  private fps: HTMLElement;
  private cheats: HTMLElement;
  private crosshair: HTMLElement;
  private scope: HTMLElement;
  private scopeZoom: HTMLElement;

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
      </section>
      <section class="hud-objective" data-hud="objective" aria-label="Current objective">
        <div><small data-hud="objective-name"></small><span data-hud="objective-meta"></span></div>
        <strong data-hud="objective-text"></strong><div class="hud-objective-track" data-hud="objective-track" role="progressbar" aria-label="Objective progress" aria-valuemin="0" aria-valuemax="100"><i data-hud="objective-fill"></i></div>
      </section>
      <section class="hud-vehicle" data-hud="vehicle" aria-label="Vehicle telemetry"><small data-hud="vehicle-name"></small><div><b data-hud="vehicle-speed"></b><span>KM/H</span></div><em data-hud="vehicle-health"></em><i class="hud-taxi" data-hud="taxi" role="status"></i></section>
      <div class="hud-prompt" data-hud="prompt" role="status"></div>
      <div class="hud-items" data-hud="items" aria-label="Carried items" hidden><i data-hud="stims" hidden></i><i data-hud="chutes" hidden></i></div>
      <div class="hud-fps" data-hud="fps"></div><div class="hud-cheats" data-hud="cheats">CHEATS ACTIVE</div>
      <div class="hud-crosshair" data-hud="crosshair" aria-hidden="true" hidden><i></i></div>`;
    this.district = required(root, '[data-hud="district"]'); this.clock = required(root, '[data-hud="clock"]'); this.reputation = required(root, '[data-hud="reputation"]');
    this.health = required(root, '[data-hud="health"]'); this.healthFill = required(root, '[data-hud="health-fill"]'); this.cash = required(root, '[data-hud="cash"]');
    this.armourBox = required(root, '[data-hud="armour-box"]'); this.armour = required(root, '[data-hud="armour"]'); this.armourFill = required(root, '[data-hud="armour-fill"]');
    this.items = required(root, '[data-hud="items"]'); this.stims = required(root, '[data-hud="stims"]'); this.chutes = required(root, '[data-hud="chutes"]');
    this.weaponName = required(root, '[data-hud="weapon-name"]'); this.ammo = required(root, '[data-hud="ammo"]'); this.reserve = required(root, '[data-hud="reserve"]'); this.reload = required(root, '[data-hud="reload"]');
    this.wantedContainer = required(root, '[data-hud="wanted"]'); this.wanted = Array.from(root.querySelectorAll<HTMLElement>('.hud-wanted i'));
    this.objective = required(root, '[data-hud="objective"]'); this.objectiveName = required(root, '[data-hud="objective-name"]'); this.objectiveText = required(root, '[data-hud="objective-text"]'); this.objectiveMeta = required(root, '[data-hud="objective-meta"]'); this.objectiveFill = required(root, '[data-hud="objective-fill"]'); this.objectiveTrack = required(root, '[data-hud="objective-track"]');
    this.prompt = required(root, '[data-hud="prompt"]'); this.vehicle = required(root, '[data-hud="vehicle"]'); this.vehicleName = required(root, '[data-hud="vehicle-name"]'); this.vehicleSpeed = required(root, '[data-hud="vehicle-speed"]'); this.vehicleHealth = required(root, '[data-hud="vehicle-health"]'); this.taxi = required(root, '[data-hud="taxi"]');
    this.fps = required(root, '[data-hud="fps"]'); this.cheats = required(root, '[data-hud="cheats"]'); this.crosshair = required(root, '[data-hud="crosshair"]');
    this.scope = required(root, '[data-hud="scope"]'); this.scopeZoom = required(root, '[data-hud="scope-zoom"]');
  }

  update(state: HudState): void {
    const health = clampPercent(state.health); this.district.textContent = state.district; this.clock.textContent = state.clock; this.reputation.textContent = state.reputation ? reputationLabel(state.reputation) : '';
    this.reputation.hidden = !state.reputation; this.health.textContent = `${health}`; this.healthFill.style.width = `${health}%`;
    const healthBox = this.health.closest<HTMLElement>('[role="progressbar"]'); healthBox?.setAttribute('aria-valuenow', String(health));
    const armour = clampPercent(state.armour); this.armourBox.hidden = armour <= 0;
    if (armour > 0) { this.armour.textContent = `${armour}`; this.armourFill.style.width = `${armour}%`; this.armourBox.setAttribute('aria-valuenow', String(armour)); }
    this.stims.hidden = state.stims <= 0; if (state.stims > 0) this.stims.textContent = `STIM ×${state.stims} · H`;
    this.chutes.hidden = state.parachutes <= 0; if (state.parachutes > 0) this.chutes.textContent = `CHUTE ×${state.parachutes}`;
    this.items.hidden = state.stims <= 0 && state.parachutes <= 0;
    this.cash.textContent = formatMoney(state.money); this.weaponName.textContent = state.weaponName;
    this.ammo.textContent = state.melee ? '—' : String(state.ammo); this.reserve.textContent = state.melee ? '' : `/ ${state.reserve}`; this.reload.hidden = !state.reloading;
    this.wanted.forEach((star, index) => star.classList.toggle('is-hot', index < state.wanted)); this.wantedContainer.setAttribute('aria-label', `Wanted level ${state.wanted} of 5`);
    this.objective.hidden = !state.objective;
    if (state.objective) {
      this.objectiveName.textContent = state.objective.missionName; this.objectiveText.textContent = state.objective.text;
      const bits: string[] = [];
      if (state.objective.required && state.objective.progress !== undefined) bits.push(`${state.objective.progress}/${state.objective.required}`);
      if (state.objective.remainingSeconds) bits.push(`${Math.ceil(state.objective.remainingSeconds)} SEC`);
      this.objectiveMeta.textContent = bits.join(' · '); const progress = objectiveProgress(state.objective); this.objectiveFill.style.width = `${progress ?? 0}%`; this.objectiveTrack.hidden = progress === undefined; this.objectiveTrack.setAttribute('aria-valuenow', String(progress ?? 0));
    }
    this.prompt.textContent = state.prompt; this.prompt.hidden = !state.prompt;
    this.vehicle.hidden = !state.vehicle;
    if (state.vehicle) {
      this.vehicleName.textContent = state.vehicle.name; this.vehicleSpeed.textContent = String(Math.round(state.vehicle.speedKph)); this.vehicleHealth.textContent = `${Math.ceil(state.vehicle.health)}% VEHICLE`;
      const taxi = state.vehicle.taxi; this.taxi.hidden = !taxi;
      if (taxi) { this.taxi.textContent = taxi.text; this.taxi.classList.toggle('is-on', taxi.available); }
    }
    this.fps.textContent = `${Math.round(state.fps)} FPS`; this.fps.hidden = !state.settings.showFps; this.cheats.hidden = !state.cheatsOn; this.crosshair.hidden = !state.crosshair;
    this.scope.hidden = !state.scope; if (state.scope) this.scopeZoom.textContent = state.scope.zoom;
  }
}
