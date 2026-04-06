import { Chess } from 'chess.js';
import { isTheoryMove, matchOpening } from './openings';

export type MoveLabel =
  | 'Brilliant'
  | 'Critical'
  | 'Best'
  | 'Excellent'
  | 'Okay'
  | 'Inaccuracy'
  | 'Mistake'
  | 'Blunder'
  | 'Theory'
  | 'Forced';

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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeEval(value: number | null) {
  if (value === null) return null;
  return clamp(value, -10000, 10000);
}

function subjectiveEval(value: number | null, color: 'w' | 'b') {
  if (value === null) return null;
  return color === 'w' ? value : -value;
}

function getExpectedPoints(cp: number, moveColor: 'w' | 'b') {
  const value = clamp(cp, -10000, 10000);

  if (Math.abs(value) >= 9999) {
    if (value === 0) return Number(moveColor === 'w');
    return Number(value > 0);
  }

  return 1 / (1 + Math.exp(-0.0035 * value));
}

function getExpectedPointsLoss(
  previousEval: number | null,
  currentEval: number | null,
  moveColor: 'w' | 'b'
) {
  if (previousEval === null || currentEval === null) return 0;

  const previous = getExpectedPoints(previousEval, moveColor === 'w' ? 'b' : 'w');
  const current = getExpectedPoints(currentEval, moveColor);

  return Math.max(0, (previous - current) * (moveColor === 'w' ? 1 : -1));
}

function accuracyFromCpl(values: number[]) {
  if (!values.length) return 100;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(clamp(100 - avg * 0.18, 0, 100) * 10) / 10;
}

function pointLossClassify(
  previousEval: number | null,
  currentEval: number | null,
  color: 'w' | 'b'
): MoveLabel {
  const pointLoss = getExpectedPointsLoss(previousEval, currentEval, color);

  if (pointLoss < 0.01) return 'Best';
  if (pointLoss < 0.045) return 'Excellent';
  if (pointLoss < 0.08) return 'Okay';
  if (pointLoss < 0.12) return 'Inaccuracy';
  if (pointLoss < 0.22) return 'Mistake';
  return 'Blunder';
}

function classifyMove(args: {
  sanMoves: string[];
  moveIndex: number;
  color: 'w' | 'b';
  before: EnginePositionResult | undefined;
  after: EnginePositionResult | undefined;
  move: {
    san: string;
    uci: string;
    fenBefore: string;
    fenAfter: string;
  };
}): MoveLabel {
  const { sanMoves, moveIndex, color, before, after, move } = args;

  const previousBoard = new Chess(move.fenBefore);
  const currentBoard = new Chess(move.fenAfter);

  if (previousBoard.moves().length <= 1) {
    return 'Forced';
  }

  if (isTheoryMove(sanMoves, moveIndex)) {
    return 'Theory';
  }

  if (currentBoard.isCheckmate()) {
    return 'Best';
  }

  const topMovePlayed = !!before?.bestMove && before.bestMove === move.uci;

  const previousEval = normalizeEval(before?.bestEvalCp ?? null);
  const currentEval = normalizeEval(after?.bestEvalCp ?? null);

  let classification: MoveLabel = topMovePlayed
    ? 'Best'
    : pointLossClassify(previousEval, currentEval, color);

  const secondLine = before?.topLines?.[1];
  if (topMovePlayed && secondLine) {
    const secondEval =
      typeof secondLine.cp === 'number'
        ? secondLine.cp
        : typeof secondLine.mate === 'number'
          ? Math.sign(secondLine.mate) * 10000
          : null;

    const secondLoss = getExpectedPointsLoss(previousEval, secondEval, color);
    const subjectiveCurrent = subjectiveEval(currentEval, color);

    if (!(subjectiveCurrent !== null && subjectiveCurrent >= 9999) && secondLoss >= 0.1) {
      classification = 'Critical';
    }
  }

  const tactical = move.san.includes('x') || move.san.includes('+') || move.san.includes('#');
  const beforeForPlayer = subjectiveEval(previousEval, color);
  const afterForPlayer = subjectiveEval(currentEval, color);

  if (
    topMovePlayed &&
    classification !== 'Critical' &&
    tactical &&
    beforeForPlayer !== null &&
    afterForPlayer !== null &&
    afterForPlayer >= beforeForPlayer + 120
  ) {
    classification = 'Brilliant';
  }

  return classification;
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

    const bestForPlayer = subjectiveEval(before?.bestEvalCp ?? null, move.color);
    const playedForPlayer = subjectiveEval(after?.bestEvalCp ?? null, move.color);

    const cpl =
      bestForPlayer !== null && playedForPlayer !== null
        ? Math.max(0, Math.round(bestForPlayer - playedForPlayer))
        : null;

    const label = classifyMove({
      sanMoves,
      moveIndex: index,
      color: move.color,
      before,
      after,
      move
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
        label === 'Forced' ? 'Only one legal move available.' :
        label === 'Best' ? 'Matches the engine top move.' :
        label === 'Brilliant' ? 'Exceptional tactical resource.' :
        label === 'Critical' ? 'Only move or uniquely strong move found.' :
        label === 'Blunder' ? 'Large drop in evaluation.' :
        label === 'Mistake' ? 'Noticeable positional or tactical loss.' :
        label === 'Inaccuracy' ? 'Small but meaningful loss of precision.' :
        'Playable move, but not the engine favorite.'
    };
  });
}

export function buildReport(moves: AnalyzedMove[]) {
  const opening = matchOpening(moves.map((m) => m.san));

  const labels: MoveLabel[] = [
    'Brilliant',
    'Critical',
    'Best',
    'Excellent',
    'Okay',
    'Inaccuracy',
    'Mistake',
    'Blunder',
    'Theory'
  ];

  const whiteCounts = Object.fromEntries(labels.map((label) => [label, 0])) as Record<Exclude<MoveLabel, 'Forced'>, number>;
  const blackCounts = Object.fromEntries(labels.map((label) => [label, 0])) as Record<Exclude<MoveLabel, 'Forced'>, number>;
  const whiteCpl: number[] = [];
  const blackCpl: number[] = [];

  for (const move of moves) {
    if (move.label !== 'Forced') {
      const counts = move.color === 'w' ? whiteCounts : blackCounts;
      counts[move.label] += 1;
    }

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
