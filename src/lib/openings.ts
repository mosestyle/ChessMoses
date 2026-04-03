export const OPENINGS = [
  { eco: 'C20', name: "King's Pawn Game", sanLine: ['e4', 'e5'] },
  { eco: 'C50', name: 'Italian Game', sanLine: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
  { eco: 'C60', name: 'Ruy Lopez', sanLine: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
  { eco: 'B20', name: 'Sicilian Defense', sanLine: ['e4', 'c5'] },
  { eco: 'C00', name: 'French Defense', sanLine: ['e4', 'e6'] },
  { eco: 'B10', name: 'Caro-Kann Defense', sanLine: ['e4', 'c6'] },
  { eco: 'D06', name: "Queen's Gambit", sanLine: ['d4', 'd5', 'c4'] },
  { eco: 'E60', name: "King's Indian Defense", sanLine: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7'] }
];

export function matchOpening(sanMoves: string[]) {
  let best = null as null | { eco: string; name: string; sanLine: string[] };
  for (const opening of OPENINGS) {
    const ok = opening.sanLine.every((move, i) => sanMoves[i] === move);
    if (!ok) continue;
    if (!best || opening.sanLine.length > best.sanLine.length) best = opening;
  }
  return best;
}

export function isTheoryMove(sanMoves: string[], index: number) {
  const prefix = sanMoves.slice(0, index + 1);
  return OPENINGS.some((opening) => prefix.every((move, i) => opening.sanLine[i] === move));
}
