import { Chess } from 'chess.js';
import type { EngineEvalResult } from './BrowserEngine';

type CloudPV = {
  moves: string;
  cp?: number;
  mate?: number;
};

type CloudEvalResponse = {
  depth: number;
  pvs: CloudPV[];
};

function normalizeCloudMove(uci: string) {
  return uci;
}

export async function getCloudEvaluation(
  fen: string,
  targetCount = 1
): Promise<{ result: EngineEvalResult; depth: number; lineCount: number } | null> {
  const response = await fetch(
    'https://lichess.org/api/cloud-eval'
    + `?fen=${encodeURIComponent(fen)}&multiPv=${targetCount}`
  );

  if (!response.ok) {
    throw new Error(`cloud evaluation failed (${response.status})`);
  }

  const cloudEvaluation = (await response.json()) as CloudEvalResponse;

  if (!cloudEvaluation?.pvs?.length) return null;

  const topLines = cloudEvaluation.pvs.map((variation) => {
    const firstMove = variation.moves.split(' ')[0];
    return {
      move: normalizeCloudMove(firstMove),
      cp: typeof variation.cp === 'number' ? variation.cp : undefined,
      mate: typeof variation.mate === 'number' ? variation.mate : undefined
    };
  });

  const first = cloudEvaluation.pvs[0];
  const firstMove = normalizeCloudMove(first.moves.split(' ')[0]);

  let bestEvalCp: number | null = null;
  if (typeof first.cp === 'number') bestEvalCp = first.cp;
  else if (typeof first.mate === 'number') bestEvalCp = Math.sign(first.mate) * 10000;

  return {
    result: {
      fen,
      bestMove: firstMove || null,
      bestEvalCp,
      topLines,
      cacheHit: false
    },
    depth: cloudEvaluation.depth || 0,
    lineCount: cloudEvaluation.pvs.length
  };
}

export function cloudMoveToSan(fen: string, uci: string | null) {
  if (!uci || uci.length < 4) return '—';

  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined
    });

    return move?.san || uci;
  } catch {
    return uci;
  }
}
