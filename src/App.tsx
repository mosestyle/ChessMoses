import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import {
  buildMoveTimelineFromPgn,
  buildReport,
  mergeAnalysis,
  parseFen,
  type AnalyzedMove,
  type EnginePositionResult,
  type MoveLabel
} from './lib/analyzer';

const DEMO_PGN = `[Event "Casual Game"]
[Site "?"]
[Date "2026.04.03"]
[Round "?"]
[White "Maria"]
[Black "Mosestyle"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Bxc3 9. d5 Bf6 10. Re1 Ne7 11. Rexe4 d6 12. Bg5 Bxg5 13. Nxg5 O-O 14. Qh5 h6 15. Rae1 Ng6 16. Nxf7 Kxf7 17. Re7+ Qxe7 18. Rexe7+ Kxe7 19. Qxg6 Rf7 20. Bd3 Bd7 21. h4 Raf8 22. f3 Kd8 23. h5 Re7 24. Kf2 Rf6 25. Qh7 Be8 26. Qh8 Kd7 27. g4 Kd8 28. Kg3 Ref7 29. Be4 Re7 30. b4 b6 31. a3 a5 32. bxa5 bxa5 33. Qh7 Re5 34. Qxg7 Rf7 35. Qxh6 Bb5 36. Qd2 a4 37. h6 Rf8 38. h7 Ree8 39. Qg5+ Kc8 40. Qg7 Rh8 41. g5 Bd7 42. g6 1-0`;

const DEMO_FEN = 'r1bq1rk1/pppp1ppp/2n2n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 6';

const LABELS = [
  'Brilliant',
  'Critical',
  'Best',
  'Excellent',
  'Good',
  'Okay',
  'Inaccuracy',
  'Mistake',
  'Blunder',
  'Theory'
] as const;

type Orientation = 'white' | 'black';
type MoveFilter = 'all' | 'bad' | 'great';

type PgnHeaders = {
  white: string;
  black: string;
  event: string;
  site: string;
  result: string;
};

type AnalyzeProgress = {
  done: number;
  total: number;
};

type SquareOverlayPosition = {
  left: number;
  top: number;
};

type DetailState = {
  loading: boolean;
  bestMove: string | null;
  evalCp: number | null;
  topLines: { move: string; cp?: number; mate?: number }[];
};

function createStockfishWorker(): { worker: Worker; blobUrl: string } {
  const workerScript =
    "self.window = self;\n" +
    "self.global = self;\n" +
    "self.process = { env: {} };\n" +
    "importScripts('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');\n";

  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(blobUrl);
  return { worker, blobUrl };
}

function getHeadersFromPgn(pgn: string): PgnHeaders {
  const read = (name: string, fallback: string) => {
    const regex = new RegExp('\\[' + name + '\\s+"([^"]*)"\\]');
    const match = pgn.match(regex);
    return match?.[1]?.trim() || fallback;
  };

  return {
    white: read('White', 'White'),
    black: read('Black', 'Black'),
    event: read('Event', ''),
    site: read('Site', ''),
    result: read('Result', '')
  };
}

function getLabelColor(label: MoveLabel) {
  switch (label) {
    case 'Brilliant':
      return '#19d3da';
    case 'Critical':
      return '#7aa2ff';
    case 'Best':
      return '#8bc34a';
    case 'Excellent':
      return '#7ed957';
    case 'Good':
      return '#a9d36e';
    case 'Okay':
      return '#c7d36f';
    case 'Inaccuracy':
      return '#f4c542';
    case 'Mistake':
      return '#ff9f43';
    case 'Blunder':
      return '#ff4d4f';
    case 'Theory':
      return '#d1b08c';
    default:
      return '#cccccc';
  }
}

function getClassificationIcon(label: MoveLabel) {
  const base = import.meta.env.BASE_URL + 'classifications/';
  switch (label) {
    case 'Brilliant':
      return base + 'brilliant.png';
    case 'Critical':
      return base + 'critical.png';
    case 'Best':
      return base + 'best.png';
    case 'Excellent':
      return base + 'excellent.png';
    case 'Good':
      return base + 'excellent.png';
    case 'Okay':
      return base + 'okay.png';
    case 'Inaccuracy':
      return base + 'inaccuracy.png';
    case 'Mistake':
      return base + 'mistake.png';
    case 'Blunder':
      return base + 'blunder.png';
    case 'Theory':
      return base + 'theory.png';
    default:
      return base + 'okay.png';
  }
}

function formatBestMove(bestMove: string | null) {
  return bestMove || '—';
}

function formatEval(cp?: number, mate?: number) {
  if (typeof mate === 'number') return '#' + mate;
  if (typeof cp === 'number') {
    const pawns = cp / 100;
    return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
  }
  return '—';
}

function getMoveTitle(move: AnalyzedMove | null) {
  if (!move) return '';
  const prefix = move.color === 'w' ? move.moveNumber + '.' : move.moveNumber + '...';
  return prefix + ' ' + move.san;
}

function getMoveSentence(move: AnalyzedMove | null) {
  if (!move) return '';
  return getMoveTitle(move) + ' is ' + move.label.toLowerCase();
}

function getSideLabel(move: AnalyzedMove | null) {
  if (!move) return '';
  return move.color === 'w' ? 'White move' : 'Black move';
}

function getLastMoveSquares(uci: string | null): { from: string; to: string } | null {
  if (!uci || uci.length < 4) return null;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4)
  };
}

function clampEval(value: number | null) {
  if (value === null || Number.isNaN(value)) return 0;
  if (value > 800) return 800;
  if (value < -800) return -800;
  return value;
}

function buildEvalGraphPath(values: number[], width: number, height: number) {
  if (!values.length) return '';
  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const normalized = (clampEval(value) + 800) / 1600;
      const y = height - normalized * height;
      return (index === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2);
    })
    .join(' ');
}

function buildEvalAreaPath(values: number[], width: number, height: number) {
  if (!values.length) return '';
  const line = buildEvalGraphPath(values, width, height);
  return line + ' L ' + width + ' ' + height + ' L 0 ' + height + ' Z';
}

function getSquareOverlayPosition(
  square: string,
  orientation: Orientation,
  boardSize: number
): SquareOverlayPosition | null {
  if (!square || square.length !== 2) return null;

  const files = 'abcdefgh';
  const file = square[0];
  const rank = Number(square[1]);

  const fileIndex = files.indexOf(file);
  if (fileIndex === -1 || rank < 1 || rank > 8) return null;

  const squareSize = boardSize / 8;
  const iconHalf = 13;

  let col = fileIndex;
  let row = 8 - rank;

  if (orientation === 'black') {
    col = 7 - fileIndex;
    row = rank - 1;
  }

  const rawLeft = (col + 1) * squareSize;
  const rawTop = row * squareSize;

  const left = Math.min(boardSize - iconHalf, Math.max(iconHalf, rawLeft));
  const top = Math.min(boardSize - iconHalf, Math.max(iconHalf, rawTop));

  return { left, top };
}

function getSquareCenter(
  square: string,
  orientation: Orientation,
  boardSize: number
): { x: number; y: number } | null {
  if (!square || square.length !== 2) return null;

  const files = 'abcdefgh';
  const file = square[0];
  const rank = Number(square[1]);

  const fileIndex = files.indexOf(file);
  if (fileIndex === -1 || rank < 1 || rank > 8) return null;

  const squareSize = boardSize / 8;

  let col = fileIndex;
  let row = 8 - rank;

  if (orientation === 'black') {
    col = 7 - fileIndex;
    row = rank - 1;
  }

  return {
    x: col * squareSize + squareSize / 2,
    y: row * squareSize + squareSize / 2
  };
}

function shortenArrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  startCut: number,
  endCut: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (!length || length <= startCut + endCut) {
    return { x1, y1, x2, y2 };
  }

  const ux = dx / length;
  const uy = dy / length;

  return {
    x1: x1 + ux * startCut,
    y1: y1 + uy * startCut,
    x2: x2 - ux * endCut,
    y2: y2 - uy * endCut
  };
}

function buildArrowPolygon(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  shaftWidth: number,
  headLength: number,
  headWidth: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (!length) return '';

  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;

  const shaftEndX = x2 - ux * headLength;
  const shaftEndY = y2 - uy * headLength;

  const p1 = [x1 + px * (shaftWidth / 2), y1 + py * (shaftWidth / 2)];
  const p2 = [shaftEndX + px * (shaftWidth / 2), shaftEndY + py * (shaftWidth / 2)];
  const p3 = [shaftEndX + px * (headWidth / 2), shaftEndY + py * (headWidth / 2)];
  const p4 = [x2, y2];
  const p5 = [shaftEndX - px * (headWidth / 2), shaftEndY - py * (headWidth / 2)];
  const p6 = [shaftEndX - px * (shaftWidth / 2), shaftEndY - py * (shaftWidth / 2)];
  const p7 = [x1 - px * (shaftWidth / 2), y1 - py * (shaftWidth / 2)];

  return [p1, p2, p3, p4, p5, p6, p7]
    .map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2))
    .join(' ');
}

async function evaluateFenWithWorker(
  worker: Worker | null,
  fen: string,
  depth: number,
  multiPv: number
): Promise<EnginePositionResult> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Stockfish worker not ready.'));
      return;
    }

    let done = false;
    let bestMove: string | null = null;
    let currentEval: number | null = null;
    const topLines: EnginePositionResult['topLines'] = [];

    const finish = () => {
      if (done) return;
      done = true;
      worker.onmessage = null;
      worker.onerror = null;
      resolve({
        fen,
        bestMove,
        bestEvalCp: currentEval,
        topLines
      });
    };

    worker.onmessage = (event: MessageEvent) => {
      const line = String(event.data);

      if (line.startsWith('info ')) {
        const moveMatch = line.match(/ pv\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
        const cpMatch = line.match(/ score cp (-?\d+)/);
        const mateMatch = line.match(/ score mate (-?\d+)/);
        const mpvMatch = line.match(/ multipv (\d+)/);

        const move = moveMatch ? moveMatch[1] : undefined;
        const cp = cpMatch ? Number(cpMatch[1]) : undefined;
        const mate = mateMatch ? Number(mateMatch[1]) : undefined;
        const mpv = mpvMatch ? Number(mpvMatch[1]) : 1;

        if (move) {
          topLines[mpv - 1] = { move, cp, mate };
          if (mpv === 1) {
            if (typeof cp === 'number') currentEval = cp;
            else if (typeof mate === 'number') currentEval = Math.sign(mate) * 10000;
          }
        }
      }

      if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        bestMove = parts.length > 1 ? parts[1] : null;
        finish();
      }
    };

    worker.onerror = () => {
      worker.onmessage = null;
      worker.onerror = null;
      reject(new Error('Stockfish worker failed during analysis.'));
    };

    worker.postMessage('stop');
    worker.postMessage('ucinewgame');
    worker.postMessage('setoption name MultiPV value ' + multiPv);
    worker.postMessage('position fen ' + fen);
    worker.postMessage('go depth ' + depth);

    setTimeout(() => {
      if (!done) worker.postMessage('stop');
    }, 5000);
  });
}

export default function App() {
  const scanWorkerRef = useRef<Worker | null>(null);
  const scanWorkerUrlRef = useRef<string | null>(null);
  const detailWorkerRef = useRef<Worker | null>(null);
  const detailWorkerUrlRef = useRef<string | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<SVGSVGElement | null>(null);
  const detailRequestIdRef = useRef(0);

  const [mode, setMode] = useState<'pgn' | 'fen'>('pgn');
  const [input, setInput] = useState<string>(DEMO_PGN);
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string>('');
  const [moves, setMoves] = useState<AnalyzedMove[]>([]);
  const [currentPly, setCurrentPly] = useState<number>(0);
  const [status, setStatus] = useState<string>('Ready');
  const [fenResult, setFenResult] = useState<EnginePositionResult | null>(null);
  const [orientation, setOrientation] = useState<Orientation>('white');
  const [progress, setProgress] = useState<AnalyzeProgress>({ done: 0, total: 0 });
  const [boardPixelSize, setBoardPixelSize] = useState<number>(520);
  const [detailState, setDetailState] = useState<DetailState | null>(null);
  const [moveFilter, setMoveFilter] = useState<MoveFilter>('all');
  const [hoveredGraphIndex, setHoveredGraphIndex] = useState<number | null>(null);
  const [showMoveMetrics, setShowMoveMetrics] = useState(false);
  const [showEngineLines, setShowEngineLines] = useState(false);

  useEffect(() => {
    const scan = createStockfishWorker();
    const detail = createStockfishWorker();

    scanWorkerRef.current = scan.worker;
    scanWorkerUrlRef.current = scan.blobUrl;
    detailWorkerRef.current = detail.worker;
    detailWorkerUrlRef.current = detail.blobUrl;

    scanWorkerRef.current.postMessage('uci');
    detailWorkerRef.current.postMessage('uci');

    return () => {
      if (scanWorkerRef.current) scanWorkerRef.current.terminate();
      if (scanWorkerUrlRef.current) URL.revokeObjectURL(scanWorkerUrlRef.current);
      if (detailWorkerRef.current) detailWorkerRef.current.terminate();
      if (detailWorkerUrlRef.current) URL.revokeObjectURL(detailWorkerUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const element = boardWrapRef.current;
    if (!element) return;

    const updateBoardSize = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setBoardPixelSize(width);
    };

    updateBoardSize();

    const observer = new ResizeObserver(() => {
      updateBoardSize();
    });

    observer.observe(element);
    window.addEventListener('resize', updateBoardSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBoardSize);
    };
  }, []);

  const headers = useMemo(() => {
    return mode === 'pgn'
      ? getHeadersFromPgn(input)
      : { white: 'White', black: 'Black', event: '', site: '', result: '' };
  }, [input, mode]);

  const currentFen = useMemo(() => {
    if (mode === 'fen') {
      try {
        return parseFen(input);
      } catch {
        return new Chess().fen();
      }
    }
    if (!moves.length) return new Chess().fen();
    return currentPly === 0 ? moves[0].fenBefore : moves[currentPly - 1].fenAfter;
  }, [mode, input, moves, currentPly]);

  const summary = useMemo(() => {
    return moves.length ? buildReport(moves) : null;
  }, [moves]);

  const selectedMove = useMemo(() => {
    if (!moves.length || currentPly === 0) return null;
    return moves[currentPly - 1];
  }, [moves, currentPly]);

  const selectedMoveLabelColor = useMemo(() => {
    return selectedMove ? getLabelColor(selectedMove.label) : '#cccccc';
  }, [selectedMove]);

  const selectedMoveIcon = useMemo(() => {
    return selectedMove ? getClassificationIcon(selectedMove.label) : '';
  }, [selectedMove]);

  const lastMoveSquares = useMemo(() => {
    return selectedMove ? getLastMoveSquares(selectedMove.uci) : null;
  }, [selectedMove]);

  const customSquareStyles = useMemo(() => {
    if (!lastMoveSquares) return {};
    return {
      [lastMoveSquares.from]: { backgroundColor: 'rgba(255, 196, 0, 0.32)' },
      [lastMoveSquares.to]: { backgroundColor: 'rgba(255, 196, 0, 0.50)' }
    };
  }, [lastMoveSquares]);

  const progressPercent = useMemo(() => {
    if (!progress.total) return 0;
    return Math.round((progress.done / progress.total) * 100);
  }, [progress]);

  const evalValues = useMemo(() => {
    return moves.map((move) => clampEval(move.playedEvalCp));
  }, [moves]);

  const graphWidth = 520;
  const graphHeight = 140;

  const evalLinePath = useMemo(() => {
    return buildEvalGraphPath(evalValues, graphWidth, graphHeight);
  }, [evalValues]);

  const evalAreaPath = useMemo(() => {
    return buildEvalAreaPath(evalValues, graphWidth, graphHeight);
  }, [evalValues]);

  const selectedGraphPoint = useMemo(() => {
    if (!moves.length || currentPly === 0 || currentPly > moves.length) return null;
    const value = clampEval(moves[currentPly - 1].playedEvalCp);
    const x = moves.length === 1 ? graphWidth / 2 : ((currentPly - 1) / (moves.length - 1)) * graphWidth;
    const normalized = (value + 800) / 1600;
    const y = graphHeight - normalized * graphHeight;
    return { x, y, value };
  }, [moves, currentPly]);

  const hoveredGraphPoint = useMemo(() => {
    if (hoveredGraphIndex === null || hoveredGraphIndex < 0 || hoveredGraphIndex >= moves.length) return null;
    const value = clampEval(moves[hoveredGraphIndex].playedEvalCp);
    const x = moves.length === 1 ? graphWidth / 2 : (hoveredGraphIndex / (moves.length - 1)) * graphWidth;
    const normalized = (value + 800) / 1600;
    const y = graphHeight - normalized * graphHeight;
    return { x, y, value, index: hoveredGraphIndex };
  }, [hoveredGraphIndex, moves]);

  const moveSquareIconPosition = useMemo(() => {
    if (!selectedMove) return null;
    const lastMove = getLastMoveSquares(selectedMove.uci);
    if (!lastMove) return null;
    return getSquareOverlayPosition(lastMove.to, orientation, boardPixelSize);
  }, [selectedMove, orientation, boardPixelSize]);

  const bestMoveArrow = useMemo(() => {
    if (!selectedMove?.bestMove) return null;
    if (selectedMove.bestMove.length < 4) return null;

    const from = selectedMove.bestMove.slice(0, 2);
    const to = selectedMove.bestMove.slice(2, 4);

    const fromCenter = getSquareCenter(from, orientation, boardPixelSize);
    const toCenter = getSquareCenter(to, orientation, boardPixelSize);

    if (!fromCenter || !toCenter) return null;

    const squareSize = boardPixelSize / 8;

    const shortened = shortenArrow(
      fromCenter.x,
      fromCenter.y,
      toCenter.x,
      toCenter.y,
      squareSize * 0.18,
      squareSize * 0.24
    );

    const polygon = buildArrowPolygon(
      shortened.x1,
      shortened.y1,
      shortened.x2,
      shortened.y2,
      squareSize * 0.16,
      squareSize * 0.28,
      squareSize * 0.34
    );

    return { polygon };
  }, [selectedMove, orientation, boardPixelSize]);

  const filteredMoves = useMemo(() => {
    if (moveFilter === 'all') return moves;
    if (moveFilter === 'bad') {
      return moves.filter((move) =>
        move.label === 'Blunder' ||
        move.label === 'Mistake' ||
        move.label === 'Inaccuracy'
      );
    }
    return moves.filter((move) =>
      move.label === 'Brilliant' ||
      move.label === 'Critical' ||
      move.label === 'Best' ||
      move.label === 'Excellent'
    );
  }, [moves, moveFilter]);

  const countsSummary = useMemo(() => {
    return {
      blunders: moves.filter((m) => m.label === 'Blunder').length,
      mistakes: moves.filter((m) => m.label === 'Mistake').length,
      inaccuracies: moves.filter((m) => m.label === 'Inaccuracy').length
    };
  }, [moves]);

  const overviewSummary = useMemo(() => {
    if (!moves.length) return null;

    const worstMove = [...moves]
      .filter((m) => typeof m.centipawnLoss === 'number')
      .sort((a, b) => (b.centipawnLoss ?? 0) - (a.centipawnLoss ?? 0))[0] || null;

    const bestMove =
      moves.find((m) => m.label === 'Brilliant') ||
      moves.find((m) => m.label === 'Best') ||
      moves.find((m) => m.label === 'Excellent') ||
      null;

    const criticalMoments = moves.filter(
      (m) => m.label === 'Critical' || m.label === 'Mistake' || m.label === 'Blunder'
    ).length;

    return {
      worstMove,
      bestMove,
      criticalMoments,
      opening: summary?.opening ? summary.eco + ' • ' + summary.opening : 'Unknown',
      blunders: moves.filter((m) => m.label === 'Blunder').length,
      mistakes: moves.filter((m) => m.label === 'Mistake').length
    };
  }, [moves, summary]);

  function jumpToNextLabel(target: MoveLabel) {
    if (!moves.length) return;

    const startIndex = Math.max(0, currentPly);
    let found = moves.findIndex((move, idx) => idx >= startIndex && move.label === target);

    if (found === -1) {
      found = moves.findIndex((move) => move.label === target);
    }

    if (found !== -1) {
      setCurrentPly(found + 1);
    }
  }

  function getGraphIndexFromClientX(clientX: number) {
    if (!graphRef.current || !moves.length) return null;
    const rect = graphRef.current.getBoundingClientRect();
    const relativeX = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const ratio = rect.width === 0 ? 0 : relativeX / rect.width;
    const index = Math.round(ratio * (moves.length - 1));
    return Math.max(0, Math.min(moves.length - 1, index));
  }

  function handleGraphMove(event: React.MouseEvent<SVGSVGElement>) {
    const index = getGraphIndexFromClientX(event.clientX);
    if (index !== null) setHoveredGraphIndex(index);
  }

  function handleGraphClick(event: React.MouseEvent<SVGSVGElement>) {
    const index = getGraphIndexFromClientX(event.clientX);
    if (index !== null) setCurrentPly(index + 1);
  }

  useEffect(() => {
    if (!selectedMove || state !== 'done' || mode !== 'pgn') {
      setDetailState(null);
      return;
    }

    const requestId = ++detailRequestIdRef.current;
    setDetailState({
      loading: true,
      bestMove: null,
      evalCp: null,
      topLines: []
    });

    evaluateFenWithWorker(detailWorkerRef.current, selectedMove.fenBefore, 12, 3)
      .then((result) => {
        if (detailRequestIdRef.current !== requestId) return;
        setDetailState({
          loading: false,
          bestMove: result.bestMove,
          evalCp: result.bestEvalCp,
          topLines: result.topLines.filter(Boolean)
        });
      })
      .catch(() => {
        if (detailRequestIdRef.current !== requestId) return;
        setDetailState({
          loading: false,
          bestMove: null,
          evalCp: null,
          topLines: []
        });
      });
  }, [selectedMove, state, mode]);

  async function runAnalysis() {
    setState('running');
    setError('');
    setMoves([]);
    setFenResult(null);
    setCurrentPly(0);
    setProgress({ done: 0, total: 0 });
    setDetailState(null);
    setMoveFilter('all');
    setHoveredGraphIndex(null);
    setShowMoveMetrics(false);
    setShowEngineLines(false);

    try {
      if (mode === 'fen') {
        setStatus('Analyzing FEN...');
        const result = await evaluateFenWithWorker(scanWorkerRef.current, parseFen(input), 10, 1);
        setFenResult(result);
        setStatus('Best move ' + (result.bestMove ?? '—') + ' | Eval ' + (result.bestEvalCp ?? '—'));
        setState('done');
        return;
      }

      const timeline = buildMoveTimelineFromPgn(input);
      const rawFens = [timeline[0]?.fenBefore, ...timeline.map((m) => m.fenAfter)].filter(Boolean) as string[];
      const fens = Array.from(new Set(rawFens));
      const engineResults: EnginePositionResult[] = [];

      setProgress({ done: 0, total: fens.length });

      for (let i = 0; i < fens.length; i++) {
        setStatus('Analyzing move ' + (i + 1) + ' / ' + fens.length);
        const result = await evaluateFenWithWorker(scanWorkerRef.current, fens[i], 10, 1);
        engineResults.push(result);
        setProgress({ done: i + 1, total: fens.length });
      }

      const analyzed = mergeAnalysis(input, engineResults);
      setMoves(analyzed);
      setStatus('Done. ' + analyzed.length + ' plies analyzed.');
      setState('done');
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : 'Analysis failed.');
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Chess Analysis Lite</h1>
          <p>
            Move details and engine lines now use default-collapsed toggle sections.
          </p>
        </div>
        <div className="status-pill">{state === 'running' ? 'Analyzing...' : status}</div>
      </header>

      <main className="layout">
        <section className="panel">
          <div className="mode-row">
            <button
              className={mode === 'pgn' ? 'active' : ''}
              onClick={() => {
                setMode('pgn');
                setInput(DEMO_PGN);
              }}
            >
              PGN
            </button>

            <button
              className={mode === 'fen' ? 'active' : ''}
              onClick={() => {
                setMode('fen');
                setInput(DEMO_FEN);
              }}
            >
              FEN
            </button>

            <button className="primary" onClick={runAnalysis} disabled={state === 'running'}>
              {state === 'running' ? 'Working...' : 'Run analysis'}
            </button>

            <button onClick={() => setOrientation((prev) => (prev === 'white' ? 'black' : 'white'))}>
              Rotate board
            </button>
          </div>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'pgn' ? 'Paste PGN here...' : 'Paste FEN here...'}
          />

          {mode === 'pgn' ? (
            <div className="players-row">
              <div className="player-box">
                <div className="player-label">White</div>
                <div className="player-name">{headers.white}</div>
              </div>
              <div className="player-box">
                <div className="player-label">Black</div>
                <div className="player-name">{headers.black}</div>
              </div>
            </div>
          ) : null}

          {state === 'running' ? (
            <div className="progress-card">
              <div className="progress-top">
                <span>Progress</span>
                <strong>{progressPercent}%</strong>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: progressPercent + '%' }} />
              </div>
              <div className="helper-text">
                {progress.done} / {progress.total} positions analyzed
              </div>
            </div>
          ) : null}

          {error ? <div className="error-box">{error}</div> : null}

          {fenResult ? (
            <div className="fen-card">
              <strong>Best move:</strong> {fenResult.bestMove ?? '—'}
              <br />
              <strong>Eval:</strong> {fenResult.bestEvalCp ?? '—'}
            </div>
          ) : null}
        </section>

        <section className="panel board-panel">
          {selectedMove ? (
            <div className="move-card polished-move-card">
              <div className="section-header-row">
                <div className="move-card-topline">
                  <img
                    src={selectedMoveIcon}
                    alt={selectedMove.label}
                    className="move-card-icon-img large-icon"
                  />
                  <div className="move-card-headings">
                    <div className="move-card-mainline" style={{ color: selectedMoveLabelColor }}>
                      {getMoveSentence(selectedMove)}
                    </div>
                    <div className="move-card-subline">
                      {getSideLabel(selectedMove)} • {getMoveTitle(selectedMove)}
                    </div>
                  </div>
                </div>

                <button
                  className="section-toggle-btn"
                  onClick={() => setShowMoveMetrics((v) => !v)}
                >
                  {showMoveMetrics ? 'Hide' : 'Show'}
                </button>
              </div>

              {showMoveMetrics ? (
                <div className="move-card-metrics">
                  <div className="move-metric-box">
                    <span className="metric-label">Best move</span>
                    <strong>{detailState?.loading ? 'Loading…' : formatBestMove(detailState?.bestMove ?? selectedMove.bestMove)}</strong>
                  </div>

                  <div className="move-metric-box">
                    <span className="metric-label">Eval</span>
                    <strong>
                      {detailState?.loading
                        ? 'Loading…'
                        : formatEval(detailState?.evalCp ?? undefined)}
                    </strong>
                  </div>

                  <div className="move-metric-box">
                    <span className="metric-label">CPL</span>
                    <strong>{selectedMove.centipawnLoss ?? '—'}</strong>
                  </div>

                  <div className="move-metric-box">
                    <span className="metric-label">Opening</span>
                    <strong>{summary?.opening ? summary.eco + ' • ' + summary.opening : 'Unknown'}</strong>
                  </div>
                </div>
              ) : (
                <div className="collapsed-note">Move details hidden</div>
              )}
            </div>
          ) : (
            <div className="move-card empty-move-card">Select a move after analysis to see details.</div>
          )}

          {detailState ? (
            <div className="engine-detail-card">
              <div className="section-header-row engine-section-header">
                <div className="engine-detail-title">Engine lines</div>
                <button
                  className="section-toggle-btn"
                  onClick={() => setShowEngineLines((v) => !v)}
                >
                  {showEngineLines ? 'Hide' : 'Show'}
                </button>
              </div>

              {showEngineLines ? (
                <>
                  {detailState.loading ? (
                    <div className="engine-detail-loading">Loading engine lines…</div>
                  ) : (
                    <>
                      <div className="engine-detail-summary">
                        <div>
                          <span className="engine-detail-label">Best move</span>
                          <strong>{detailState.bestMove ?? '—'}</strong>
                        </div>
                        <div>
                          <span className="engine-detail-label">Eval</span>
                          <strong>{formatEval(detailState.evalCp ?? undefined)}</strong>
                        </div>
                      </div>

                      <div className="engine-lines-list">
                        {detailState.topLines.length ? (
                          detailState.topLines.map((line, index) => (
                            <div className="engine-line-row" key={index}>
                              <span className="engine-line-rank">#{index + 1}</span>
                              <span className="engine-line-move">{line.move}</span>
                              <span className="engine-line-eval">{formatEval(line.cp, line.mate)}</span>
                            </div>
                          ))
                        ) : (
                          <div className="engine-detail-loading">No lines available.</div>
                        )}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className="collapsed-note">Engine lines hidden</div>
              )}
            </div>
          ) : null}

          {moves.length ? (
            <div className="eval-card">
              <div className="eval-card-title">Evaluation Graph</div>
              <svg
                ref={graphRef}
                viewBox={'0 0 ' + graphWidth + ' ' + graphHeight}
                className="eval-graph clickable-graph"
                preserveAspectRatio="none"
                onMouseMove={handleGraphMove}
                onMouseLeave={() => setHoveredGraphIndex(null)}
                onClick={handleGraphClick}
              >
                <rect x="0" y="0" width={graphWidth} height={graphHeight / 2} className="eval-top-zone" />
                <rect x="0" y={graphHeight / 2} width={graphWidth} height={graphHeight / 2} className="eval-bottom-zone" />
                <line x1="0" y1={graphHeight / 2} x2={graphWidth} y2={graphHeight / 2} className="eval-midline" />
                {evalAreaPath ? <path d={evalAreaPath} className="eval-area" /> : null}
                {evalLinePath ? <path d={evalLinePath} className="eval-line" /> : null}

                {hoveredGraphPoint ? (
                  <>
                    <line
                      x1={hoveredGraphPoint.x}
                      y1="0"
                      x2={hoveredGraphPoint.x}
                      y2={graphHeight}
                      className="eval-hover-line"
                    />
                    <circle
                      cx={hoveredGraphPoint.x}
                      cy={hoveredGraphPoint.y}
                      r="5"
                      className="eval-hover-dot"
                    />
                  </>
                ) : null}

                {selectedGraphPoint ? (
                  <>
                    <line
                      x1={selectedGraphPoint.x}
                      y1="0"
                      x2={selectedGraphPoint.x}
                      y2={graphHeight}
                      className="eval-marker-line"
                    />
                    <circle
                      cx={selectedGraphPoint.x}
                      cy={selectedGraphPoint.y}
                      r="5"
                      className="eval-marker-dot"
                    />
                  </>
                ) : null}
              </svg>
            </div>
          ) : null}

          <div className="board-stack">
            <div className="board-wrap" ref={boardWrapRef}>
              <Chessboard
                id="analysis-board"
                position={currentFen}
                arePiecesDraggable={false}
                boardWidth={520}
                boardOrientation={orientation}
                customSquareStyles={customSquareStyles}
              />

              {bestMoveArrow ? (
                <svg
                  className="board-arrow-overlay"
                  viewBox={'0 0 ' + boardPixelSize + ' ' + boardPixelSize}
                  preserveAspectRatio="none"
                >
                  <polygon points={bestMoveArrow.polygon} className="board-arrow-shape" />
                </svg>
              ) : null}

              {selectedMove && moveSquareIconPosition ? (
                <img
                  src={selectedMoveIcon}
                  alt={selectedMove.label}
                  className="square-annotation-icon-img"
                  style={{
                    left: moveSquareIconPosition.left + 'px',
                    top: moveSquareIconPosition.top + 'px'
                  }}
                />
              ) : null}
            </div>
          </div>

          {moves.length ? (
            <div className="scrubber">
              <button onClick={() => setCurrentPly(0)}>Start</button>
              <button onClick={() => setCurrentPly((v) => Math.max(0, v - 1))}>Prev</button>
              <span>{currentPly} / {moves.length}</span>
              <button onClick={() => setCurrentPly((v) => Math.min(moves.length, v + 1))}>Next</button>
              <button onClick={() => setCurrentPly(moves.length)}>End</button>
            </div>
          ) : null}
        </section>

        <section className="panel">
          {summary ? (
            <>
              {overviewSummary ? (
                <div className="overview-cards-grid">
                  <div className="overview-card">
                    <div className="overview-card-label">Worst move</div>
                    <div className="overview-card-value">
                      {overviewSummary.worstMove ? getMoveTitle(overviewSummary.worstMove) : '—'}
                    </div>
                    <div className="overview-card-sub">
                      {overviewSummary.worstMove ? 'CPL ' + (overviewSummary.worstMove.centipawnLoss ?? '—') : ''}
                    </div>
                  </div>

                  <div className="overview-card">
                    <div className="overview-card-label">Best move</div>
                    <div className="overview-card-value">
                      {overviewSummary.bestMove ? getMoveTitle(overviewSummary.bestMove) : '—'}
                    </div>
                    <div className="overview-card-sub">
                      {overviewSummary.bestMove ? overviewSummary.bestMove.label : ''}
                    </div>
                  </div>

                  <div className="overview-card">
                    <div className="overview-card-label">Critical moments</div>
                    <div className="overview-card-value">{overviewSummary.criticalMoments}</div>
                    <div className="overview-card-sub">Critical, mistakes, blunders</div>
                  </div>

                  <div className="overview-card">
                    <div className="overview-card-label">Opening</div>
                    <div className="overview-card-value">{overviewSummary.opening}</div>
                    <div className="overview-card-sub">Game opening</div>
                  </div>

                  <div className="overview-card">
                    <div className="overview-card-label">Blunders</div>
                    <div className="overview-card-value">{overviewSummary.blunders}</div>
                    <div className="overview-card-sub">Total blunders</div>
                  </div>

                  <div className="overview-card">
                    <div className="overview-card-label">Mistakes</div>
                    <div className="overview-card-value">{overviewSummary.mistakes}</div>
                    <div className="overview-card-sub">Total mistakes</div>
                  </div>
                </div>
              ) : null}

              <div className="summary-grid">
                <div className="summary-card">
                  <h3>Opening</h3>
                  <p>{summary.opening ? summary.eco + ' • ' + summary.opening : 'Unknown'}</p>
                </div>
                <div className="summary-card">
                  <h3>{headers.white}</h3>
                  <p>{summary.white.accuracy}%</p>
                </div>
                <div className="summary-card">
                  <h3>{headers.black}</h3>
                  <p>{summary.black.accuracy}%</p>
                </div>
              </div>

              <div className="accuracy-strip-card">
                <div className="accuracy-strip-title">Accuracies</div>
                <div className="accuracy-strip">
                  <div className="accuracy-left" style={{ width: summary.white.accuracy + '%' }}>
                    {summary.white.accuracy}%
                  </div>
                  <div className="accuracy-right" style={{ width: summary.black.accuracy + '%' }}>
                    {summary.black.accuracy}%
                  </div>
                </div>
                <div className="accuracy-names">
                  <span>{headers.white}</span>
                  <span>{headers.black}</span>
                </div>
              </div>

              <div className="move-list-toolbar">
                <div className="jump-group">
                  <button className="toolbar-btn danger" onClick={() => jumpToNextLabel('Blunder')}>
                    Blunders ({countsSummary.blunders})
                  </button>
                  <button className="toolbar-btn warning" onClick={() => jumpToNextLabel('Mistake')}>
                    Mistakes ({countsSummary.mistakes})
                  </button>
                  <button className="toolbar-btn caution" onClick={() => jumpToNextLabel('Inaccuracy')}>
                    Inaccuracies ({countsSummary.inaccuracies})
                  </button>
                </div>

                <div className="filter-group">
                  <button
                    className={'toolbar-btn ' + (moveFilter === 'all' ? 'active-filter' : '')}
                    onClick={() => setMoveFilter('all')}
                  >
                    All
                  </button>
                  <button
                    className={'toolbar-btn ' + (moveFilter === 'bad' ? 'active-filter' : '')}
                    onClick={() => setMoveFilter('bad')}
                  >
                    Bad moves
                  </button>
                  <button
                    className={'toolbar-btn ' + (moveFilter === 'great' ? 'active-filter' : '')}
                    onClick={() => setMoveFilter('great')}
                  >
                    Great moves
                  </button>
                </div>
              </div>

              <div className="counts-grid">
                <div>
                  <h3>{headers.white}</h3>
                  {LABELS.map((label) => {
                    return (
                      <div key={'w-' + label} className="count-row">
                        <span className="count-label-with-icon">
                          <img
                            src={getClassificationIcon(label)}
                            alt={label}
                            className="report-icon-img"
                          />
                          <span style={{ color: getLabelColor(label) }}>{label}</span>
                        </span>
                        <strong>{summary.white.counts[label]}</strong>
                      </div>
                    );
                  })}
                </div>

                <div>
                  <h3>{headers.black}</h3>
                  {LABELS.map((label) => {
                    return (
                      <div key={'b-' + label} className="count-row">
                        <span className="count-label-with-icon">
                          <img
                            src={getClassificationIcon(label)}
                            alt={label}
                            className="report-icon-img"
                          />
                          <span style={{ color: getLabelColor(label) }}>{label}</span>
                        </span>
                        <strong>{summary.black.counts[label]}</strong>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="move-list">
                {filteredMoves.map((move) => {
                  const originalIndex = moves.findIndex((m) => m.ply === move.ply && m.uci === move.uci);
                  return (
                    <button
                      key={move.ply + '-' + move.uci}
                      className={'move-item ' + (currentPly === originalIndex + 1 ? 'selected' : '')}
                      onClick={() => setCurrentPly(originalIndex + 1)}
                    >
                      <div className="move-left">
                        <img
                          src={getClassificationIcon(move.label)}
                          alt={move.label}
                          className="move-list-icon-img"
                        />
                        <div>
                          <strong>
                            {move.moveNumber}
                            {move.color === 'w' ? '.' : '...'} {move.san}
                          </strong>
                          <div className="mini">
                            {move.label} • Best: {move.bestMove ?? '—'} • CPL: {move.centipawnLoss ?? '—'}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}

                {!filteredMoves.length ? (
                  <div className="empty-state">No moves match this filter.</div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="empty-state">Run a PGN analysis to see the move report here.</div>
          )}
        </section>
      </main>
    </div>
  );
}
