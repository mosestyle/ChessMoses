import { Chess } from 'chess.js';
import { isTheoryMove, matchOpening } from './openings';

export type MoveLabel =
  | 'Brilliant'
  | 'Critical'
  | 'Best'
  | 'Excellent'
  | 'Good'
  | 'Okay'
  | 'Inaccuracy'
  | 'Mistake'
  | 'Blunder'
  | 'Theory';

export type EnginePositionResult = {
  fen: string;
  bestMove: string | null;
  bestEvalCp: number | null;
  topLines: { move: string; cp?: number; mate?: number }[];
};

export type AnalyzedMove = {
  ply: number;
  moveNumber: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  bestEvalCp: number | null;
  playedEvalCp: number | null;
  centipawnLoss: number | null;
  label: MoveLabel;
  bestMove: string | null;
  comment: string;
};

function evalForColor(cp: number | null, color: 'w' | 'b') {
  if (cp === null) return null;
  return color === 'w' ? cp : -cp;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function accuracyFromCpl(values: number[]) {
  if (!values.length) return 100;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(clamp(100 - avg * 0.18, 0, 100) * 10) / 10;
}

function classifyMove(args: {
  sanMoves: string[];
  moveIndex: number;
  color: 'w' | 'b';
  cpl: number | null;
  bestEvalCp: number | null;
  playedEvalCp: number | null;
  bestMove: string | null;
  playedMoveUci: string;
  san: string;
}): MoveLabel {
  const { sanMoves, moveIndex, color, cpl, bestEvalCp, playedEvalCp, bestMove, playedMoveUci, san } = args;
  if (isTheoryMove(sanMoves, moveIndex)) return 'Theory';
  if (cpl === null) return 'Okay';
  if (bestMove && bestMove === playedMoveUci && cpl <= 8) return 'Best';

  const bestForPlayer = evalForColor(bestEvalCp, color);
  const playedForPlayer = evalForColor(playedEvalCp, color);
  const tactical = san.includes('x') || san.includes('+') || san.includes('#');

  if (cpl <= 20 && tactical && bestForPlayer !== null && playedForPlayer !== null && playedForPlayer > bestForPlayer + 120) return 'Brilliant';
  if (cpl <= 20) return 'Excellent';
  if (cpl <= 40) return 'Good';
  if (cpl <= 80) return 'Okay';
  if (cpl <= 140) return 'Inaccuracy';
  if (cpl <= 280) {
    if (bestForPlayer !== null && playedForPlayer !== null && bestForPlayer > 150 && playedForPlayer < 30) return 'Critical';
    return 'Mistake';
  }
  return 'Blunder';
}

export function parseFen(input: string) {
  const chess = new Chess();
  chess.load(input);
  return chess.fen();
}

export function buildMoveTimelineFromPgn(pgn: string) {
  const replay = new Chess();
  replay.loadPgn(pgn);
  const verbose = replay.history({ verbose: true });
  const sanMoves = replay.history();
  const chess = new Chess();

  return verbose.map((move, idx) => {
    const fenBefore = chess.fen();
    chess.move(move);
    return {
      ply: idx + 1,
      moveNumber: Math.floor(idx / 2) + 1,
      color: move.color,
      san: sanMoves[idx],
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      fenBefore,
      fenAfter: chess.fen()
    };
  });
}

export function mergeAnalysis(pgn: string, engineResults: EnginePositionResult[]): AnalyzedMove[] {
  const timeline = buildMoveTimelineFromPgn(pgn);
  const sanMoves = timeline.map((m) => m.san);
  const byFen = new Map(engineResults.map((r) => [r.fen, r]));

  return timeline.map((move, index) => {
    const before = byFen.get(move.fenBefore);
    const after = byFen.get(move.fenAfter);
    const bestForPlayer = evalForColor(before?.bestEvalCp ?? null, move.color);
    const playedForPlayer = evalForColor(after?.bestEvalCp ?? null, move.color);
    const cpl = bestForPlayer !== null && playedForPlayer !== null ? Math.max(0, Math.round(bestForPlayer - playedForPlayer)) : null;

    const label = classifyMove({
      sanMoves,
      moveIndex: index,
      color: move.color,
      cpl,
      bestEvalCp: before?.bestEvalCp ?? null,
      playedEvalCp: after?.bestEvalCp ?? null,
      bestMove: before?.bestMove ?? null,
      playedMoveUci: move.uci,
      san: move.san
    });

    return {
      ...move,
      bestEvalCp: before?.bestEvalCp ?? null,
      playedEvalCp: after?.bestEvalCp ?? null,
      centipawnLoss: cpl,
      label,
      bestMove: before?.bestMove ?? null,
      comment:
        label === 'Theory' ? 'Still inside opening theory.' :
        label === 'Best' ? 'Matches the engine top move.' :
        label === 'Brilliant' ? 'Strong tactical resource with a major positive swing.' :
        label === 'Critical' ? 'Important missed chance in a sharp position.' :
        label === 'Blunder' ? 'Large drop in evaluation.' :
        label === 'Mistake' ? 'Noticeable positional or tactical loss.' :
        label === 'Inaccuracy' ? 'Small but meaningful loss of precision.' :
        'Playable move, but not the engine favorite.'
    };
  });
}

export function buildReport(moves: AnalyzedMove[]) {
  const opening = matchOpening(moves.map((m) => m.san));
  const labels: MoveLabel[] = ['Brilliant', 'Critical', 'Best', 'Excellent', 'Good', 'Okay', 'Inaccuracy', 'Mistake', 'Blunder', 'Theory'];
  const whiteCounts = Object.fromEntries(labels.map((label) => [label, 0])) as Record<MoveLabel, number>;
  const blackCounts = Object.fromEntries(labels.map((label) => [label, 0])) as Record<MoveLabel, number>;
  const whiteCpl: number[] = [];
  const blackCpl: number[] = [];

  for (const move of moves) {
    const counts = move.color === 'w' ? whiteCounts : blackCounts;
    counts[move.label] += 1;
    if (move.centipawnLoss !== null) {
      (move.color === 'w' ? whiteCpl : blackCpl).push(move.centipawnLoss);
    }
  }

  return {
    opening: opening?.name ?? null,
    eco: opening?.eco ?? null,
    white: { accuracy: accuracyFromCpl(whiteCpl), counts: whiteCounts },
    black: { accuracy: accuracyFromCpl(blackCpl), counts: blackCounts }
  };
}
