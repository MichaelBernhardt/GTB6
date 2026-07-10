import './styles.css';
import { Game } from './Game';

const container = document.querySelector<HTMLElement>('#game');
if (!container) throw new Error('Game container not found');
new Game(container);
