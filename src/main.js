import { Game } from './game.js';

// Entry point. The game is exposed on window for poking at from the console,
// e.g. game.player.inventory.add({ id: 'diamond', count: 64 }) or game.world.time = 13000.
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!hasWebGL()) {
  window.showBootError?.('Your browser has 3D graphics (WebGL) turned off or unsupported. Turn on hardware acceleration in your browser settings, or try Chrome, Edge or Firefox.');
} else {
  try {
    window.game = new Game();
  } catch (e) {
    window.showBootError?.(`The game failed to start: ${e.message}`);
    throw e;
  }
}
