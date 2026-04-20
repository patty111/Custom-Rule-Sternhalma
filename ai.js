// Simple greedy AI: choose move that maximally advances pieces toward target.
import { allTurnMoves, parseKey, hexDist, triangleAnchor } from './game.js';

export function chooseAIMove(state) {
  const player = state.players[state.turn];
  const target = triangleAnchor(player.targetTriangle);
  let best = null;
  // Iterate over all of this player's pieces.
  const myPieces = [];
  for (const [k, pid] of state.occupancy) {
    if (pid === player.id) myPieces.push(k);
  }
  for (const fromKey of myPieces) {
    const moves = allTurnMoves(state, fromKey);
    for (const [destKey, info] of moves) {
      const fromCoord = parseKey(fromKey);
      const destCoord = parseKey(destKey);
      const advance = hexDist(fromCoord, target) - hexDist(destCoord, target);
      // Slight bonus for moving the laggard (piece farthest from target).
      const lagBonus = hexDist(fromCoord, target) * 0.05;
      const score = advance + lagBonus + Math.random() * 0.01;
      if (!best || score > best.score) {
        best = { score, fromKey, destKey, info };
      }
    }
  }
  return best;
}
