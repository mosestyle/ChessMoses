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

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Bxc3 9. d5 Bf6 10. Re1 Ne7 11. Rxe4 d6 12. Bg5 Bxg5 13. Nxg5 O-O 14. Qh5 h6 15. Rae1 Ng6 16. Nxf7 Kxf7 17. Re7+ Qxe7 18. Rxe7+ Kxe7 19. Qxg6 Rf7 20. Bd3 Bd7 21. h4 Raf8 22. f3 Kd8 23. h5 Re7 24. Kf2 Rf6 25. Qh7 Be8 26. Qh8 Kd7 27. g4 Kd8 28. Kg3 Ref7 29. Be4 Re7 30. b4 b6 31. a3 a5 32. bxa5 bxa5 33. Qh7 Re5 34. Qxg7 Rf7 35. Qxh6 Bb5 36. Qd2 a4 37. h6 Rf8 38. h7 Ree8 39. Qg5+ Kc8 40. Qg7 Rh8 41. g5 Bd7 42. g6 1-0`;

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

function getMoveColors(label: MoveLabel) {
  switch (label) {
    case 'Brilliant':
      return { icon: '!!', color: '#19d3da', text: '#19d3da' };
    case 'Critical':
      return { icon: '!', color: '#7aa2ff', text: '#7aa2ff' };
    case 'Best':
      return { icon: '★', color: '#8bc34a', text: '#8bc34a' };
    case 'Excellent':
      return { icon: '👍', color: '#7ed957', text: '#7ed957' };
    case 'Good':
      return { icon: '✓', color: '#a9d36e', text: '#a9d36e' };
    case 'Okay':
      return { icon: '✓', color: '#c7d36f', text: '#c7d36f' };
    case 'Inaccuracy':
      return { icon: '?!', color: '#f4c542', text: '#f4c542' };
    case 'Mistake':
      return { icon: '?', color: '#ff9f43', text: '#ff9f43' };
    case 'Blunder':
      return { icon: '??', color: '#ff4d4f', text: '#ff4d4f' };
    case 'Theory':
      return { icon: '📖', color: '#d1b08c', text: '#d1b08c' };
    default:
      return { icon: '•', color: '#cccccc', text: '#cccccc' };
  }
}

function formatBestMove(bestMove: string | null) {
  if (!bestMove) return '—';
  return bestMove;
}

function getLastMoveSquares(uci: string | null): { from: string; to: string } | null {
  if (!uci || uci.length < 4) return null;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4)
  };
}

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const workerUrlRef = useRef<string | null>(null);

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

  useEffect(() => {
    const setup = createStockfishWorker();
    workerRef.current = setup.worker;
    workerUrlRef.current = setup.blobUrl;

    workerRef.current.postMessage('uci');

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
      if (workerUrlRef.current) {
        URL.revokeObjectURL(workerUrlRef.current);
      }
    };
  }, []);

  const headers = useMemo(() => {
    return mode === 'pgn' ? getHeadersFromPgn(input) : {
      white: 'White',
      black: 'Black',
      event: '',
      site: '',
      result: ''
    };
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

  const selectedMoveStyle = useMemo(() => {
    if (!selectedMove) return null;
    return getMoveColors(selectedMove.label);
  }, [selectedMove]);

  const lastMoveSquares = useMemo(() => {
    return selectedMove ? getLastMoveSquares(selectedMove.uci) : null;
  }, [selectedMove]);

  const customSquareStyles = useMemo(() => {
    if (!lastMoveSquares) return {};
    return {
      [lastMoveSquares.from]: {
        backgroundColor: 'rgba(255, 196, 0, 0.35)'
      },
      [lastMoveSquares.to]: {
        backgroundColor: 'rgba(255, 196, 0, 0.55)'
      }
    };
  }, [lastMoveSquares]);

  const progressPercent = useMemo(() => {
    if (!progress.total) return 0;
    return Math.round((progress.done / progress.total) * 100);
  }, [progress]);

  async function evaluateFen(
    fen: string,
    depth: number,
    multiPv: number
  ): Promise<EnginePositionResult> {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
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
            topLines[mpv - 1] = {
              move,
              cp,
              mate
            };

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
        if (!done) {
          worker.postMessage('stop');
        }
      }, 5000);
    });
  }

  async function runAnalysis() {
    setState('running');
    setError('');
    setMoves([]);
    setFenResult(null);
    setCurrentPly(0);
    setProgress({ done: 0, total: 0 });

    try {
      if (mode === 'fen') {
        setStatus('Analyzing FEN...');
        const result = await evaluateFen(parseFen(input), 10, 1);
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
        const result = await evaluateFen(fens[i], 10, 1);
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
            Faster Version 2A with player names, rotate board, last move highlight,
            progress bar, and move details card.
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

            <button
              onClick={() => {
                setOrientation((prev) => (prev === 'white' ? 'black' : 'white'));
              }}
            >
              Rotate board
            </button>
          </div>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'pgn' ? 'Paste PGN here...' : 'Paste FEN here...'}
          />

          <div className="helper-text">
            PGN mode now shows player names from the PGN, board rotation, last move highlight,
            and faster full-game analysis.
          </div>

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
          {selectedMove && selectedMoveStyle ? (
            <div className="move-card">
              <div className="move-card-title" style={{ color: selectedMoveStyle.text }}>
                <span className="move-icon" style={{ backgroundColor: selectedMoveStyle.color }}>
                  {selectedMoveStyle.icon}
                </span>
                <span>
                  {selectedMove.san} is {selectedMove.label.toLowerCase()}
                </span>
              </div>

              {selectedMove.bestMove ? (
                <div className="best-move-line">
                  The best move was <span>{formatBestMove(selectedMove.bestMove)}</span>
                </div>
              ) : null}

              <div className="opening-line">
                {summary?.opening ? summary.eco + ': ' + summary.opening : 'Opening unknown'}
              </div>
            </div>
          ) : (
            <div className="move-card empty-move-card">
              Select a move after analysis to see details.
            </div>
          )}

          <div className="board-wrap">
            <Chessboard
              id="analysis-board"
              position={currentFen}
              arePiecesDraggable={false}
              boardWidth={520}
              boardOrientation={orientation}
              customSquareStyles={customSquareStyles}
            />
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

              <div className="counts-grid">
                <div>
                  <h3>{headers.white}</h3>
                  {LABELS.map((label) => {
                    const style = getMoveColors(label);
                    return (
                      <div key={'w-' + label} className="count-row">
                        <span style={{ color: style.text }}>{label}</span>
                        <strong>{summary.white.counts[label]}</strong>
                      </div>
                    );
                  })}
                </div>

                <div>
                  <h3>{headers.black}</h3>
                  {LABELS.map((label) => {
                    const style = getMoveColors(label);
                    return (
                      <div key={'b-' + label} className="count-row">
                        <span style={{ color: style.text }}>{label}</span>
                        <strong>{summary.black.counts[label]}</strong>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="move-list">
                {moves.map((move, idx) => {
                  const style = getMoveColors(move.label);
                  return (
                    <button
                      key={move.ply + '-' + move.uci}
                      className={'move-item ' + (currentPly === idx + 1 ? 'selected' : '')}
                      onClick={() => setCurrentPly(idx + 1)}
                    >
                      <div className="move-left">
                        <span className="move-list-icon" style={{ backgroundColor: style.color }}>
                          {style.icon}
                        </span>
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
