import type { NetPlayer } from './protocol';
import { rankOnlinePlayers } from './presentation';

export class MultiplayerOverlay {
  root = document.createElement('section');
  private status = document.createElement('div');
  private feed = document.createElement('div');
  private scoreboard = document.createElement('div');
  private chatLog = document.createElement('div');
  private form = document.createElement('form');
  private input = document.createElement('input');
  private playerListSignature = '';
  onChat?: (text: string) => void;

  constructor() {
    this.root.id = 'multiplayer-overlay'; this.root.hidden = true;
    this.status.className = 'multiplayer-status'; this.feed.className = 'multiplayer-feed'; this.scoreboard.className = 'multiplayer-scoreboard'; this.chatLog.className = 'multiplayer-chat-log'; this.form.className = 'multiplayer-chat';
    this.input.maxLength = 180; this.input.placeholder = 'Press Enter to chat'; this.input.setAttribute('aria-label', 'Global multiplayer chat');
    this.form.append(this.input); this.root.append(this.status, this.feed, this.scoreboard, this.chatLog, this.form); document.body.append(this.root);
    this.form.addEventListener('submit', (event) => { event.preventDefault(); const text = this.input.value.trim(); if (text) this.onChat?.(text); this.input.value = ''; this.input.blur(); });
    this.input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.code === 'Escape') { event.preventDefault(); this.input.value = ''; this.input.blur(); } });
    window.addEventListener('keydown', (event) => { if (!this.root.hidden && event.code === 'Enter' && document.activeElement !== this.input) { event.preventDefault(); this.input.focus(); } });
  }

  show(): void { this.root.hidden = false; }
  hide(): void { this.root.hidden = true; }
  setStatus(text: string, danger = false): void { this.status.textContent = text; this.status.classList.toggle('is-danger', danger); }
  setPlayers(players: NetPlayer[], selfId?: string, carrierId?: string): void {
    const ordered = rankOnlinePlayers(players);
    const signature = JSON.stringify(ordered.map((player) => [player.id, player.name, player.runs, player.kills, player.deaths, player.id === selfId, player.id === carrierId]));
    if (signature === this.playerListSignature) return;
    this.playerListSignature = signature;
    this.scoreboard.replaceChildren();
    const title = document.createElement('strong'); title.textContent = `ONLINE · ${players.length}/16`; this.scoreboard.append(title);
    for (const player of ordered) {
      const row = document.createElement('span'); row.classList.toggle('is-self', player.id === selfId); row.classList.toggle('is-carrier', player.id === carrierId);
      const name = document.createElement('b'); name.textContent = `${player.id === carrierId ? '🔥 ' : ''}${player.name}`; const stats = document.createElement('small'); stats.textContent = `${player.runs} R · ${player.kills} K · ${player.deaths} D`;
      row.append(name, stats); this.scoreboard.append(row);
    }
  }
  chat(name: string, text: string, system = false): void {
    const row = document.createElement('p'); row.className = system ? 'is-system' : '';
    const author = document.createElement('b'); author.textContent = `${name}: `; row.append(author, document.createTextNode(text)); this.chatLog.append(row);
    while (this.chatLog.childElementCount > 8) this.chatLog.firstElementChild?.remove();
  }
  event(text: string): void {
    const row = document.createElement('p'); row.textContent = text; this.feed.append(row); setTimeout(() => row.remove(), 5000);
  }
}
