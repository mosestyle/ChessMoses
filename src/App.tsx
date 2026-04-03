import { useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import {
  buildMoveTimelineFromPgn,
  buildReport,
  mergeAnalysis,
  parseFen,
  type AnalyzedMove,
  type EnginePositionResult
} from './lib/analyzer';

const DEMO_PGN = `[Event "Casual Game"]
[Site "?"]
[Date "2026.04.03"]
[Round "?"]
[White "White"]
[Black "Black"]
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

function createStockfishWorker() {
  const workerScript = `
    self.window = self;
    self.global = self;
    self.process = { env: {} };
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
  `;
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(blobUrl);
  return { worker, blobUrl };
}

export default function App() {
  const [mode, setMode] = useState<'pgn' | 'fen'>('pgn');
  const [input, setInput] = useState(DEMO_PGN);
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [moves, setMoves] = useState<AnalyzedMove[]>([]);
  const [currentPly, setCurrentPly] = useState(0);
  const [status, setStatus] = useState('Ready');
  const [fenResult, setFenResult] = useState<EnginePositionResult | null>(null);

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

  async function evaluateFen(fen: string, depth = 14): Promise<EnginePositionResult> {
    return new Promise((resolve, reject) => {
      const { worker, blobUrl } = createStockfishWorker();
      let done = false;
      let bestMove: string | null = null;
      let currentEval: number | null = null;
      const topLines: EnginePositionResult['topLines'] = [];

      const cleanup = () => {
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
      };

      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve({
          fen,
          bestMove,
          bestEvalCp: currentEval,
          topLines
        });
      };

      worker.onmessage = (event) => {
        const line = String(event.data);

        if (line.startsWith('info ')) {
          const move = line.match(/ pv\\s+([a-h][1-8][a-h][1-8][qrbn]?)/)?.[1];
          const cp = line.match(/ score cp (-?\\d+)/)?.[1];
          const mate = line.match(/ score mate (-?\\d+)/)?.[1];
          const mpv = Number(line.match(/ multipv (\\d+)/)?.[1] ?? '1');

          if (move) {
            const entry = {
              move,
              cp: cp ? Number(cp) : undefined,
              mate: mate ? Number(mate) : undefined
            };

            topLines[mpv - 1] = entry;

            if (mpv === 1) {
              currentEval = cp
                ? Number(cp)
                : mate
                  ? Math.sign(Number(mate)) * 10000
                  : currentEval;
            }
          }
        }

        if (line.startsWith('bestmove')) {
          bestMove = line.split(' ')[1] ?? null;
          finish();
        }
      };

      worker.onerror = () => {
        cleanup();
        reject(new Error('Stockfish worker failed to load.'));
      };

      worker.postMessage('uci');
      worker.postMessage('setoption name MultiPV value 3');
      worker.postMessage(\`position fen \${fen}\`);
      worker.postMessage(\`go depth \${depth}\`);

      setTimeout(() => {
        if (!done) finish();
      }, 12000);
    });
  }

  async function runAnalysis() {
    setState('running');
    setError('');
    setMoves([]);
    setFenResult(null);
    setCurrentPly(0);

    try {
      if (mode === 'fen') {
        setStatus('Analyzing FEN...');
        const result = await evaluateFen(parseFen(input), 16);
        setFenResult(result);
        setStatus(\`Best move \${result.bestMove ?? '—'} | Eval \${result.bestEvalCp ?? '—'}\`);
        setState('done');
        return;
      }

      const timeline = buildMoveTimelineFromPgn(input);
      const fens = Array.from(
        new Set(
          [timeline[0]?.fenBefore, ...timeline.map((m) => m.fenAfter)].filter(Boolean) as string[]
        )
      );

      const engineResults: EnginePositionResult[] = [];

      for (let i = 0; i < fens.length; i++) {
        setStatus(\`Analyzing \${i + 1}/\${fens.length}\`);
        engineResults.push(await evaluateFen(fens[i], 13));
      }

      const analyzed = mergeAnalysis(input, engineResults);
      setMoves(analyzed);
      setStatus(\`Done. \${analyzed.length} plies analyzed.\`);
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
            Small repo, mobile friendly layout, PGN and FEN input, browser Stockfish,
            move labels, and report cards.
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

            <button
              className="primary"
              onClick={runAnalysis}
              disabled={state === 'running'}
            >
              {state === 'running' ? 'Working...' : 'Run analysis'}
            </button>
          </div>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'pgn' ? 'Paste PGN here...' : 'Paste FEN here...'}
          />

          <div className="helper-text">
            PGN mode makes a full report. FEN mode evaluates the current position and best line.
          </div>

          {error ? <div className="error-box">{error}</div> : null}

          {fenResult ? (
            <div className="fen-card">
              <strong>Best move:</strong> {fenResult.bestMove ?? '—'}
              <br />
              <strong>Eval:</strong> {fenResult.bestEvalCp ?? '—'}
              <br />
              <strong>Top lines:</strong>{' '}
              {fenResult.topLines
                .filter(Boolean)
                .map((line) => `${line.move} (${line.cp ?? line.mate ?? '—'})`)
                .join(' • ')}
            </div>
          ) : null}
        </section>

        <section className="panel board-panel">
          <div className="board-wrap">
            <Chessboard
              id="analysis-board"
              position={currentFen}
              arePiecesDraggable={false}
              boardWidth={520}
            />
          </div>

          {moves.length ? (
            <div className="scrubber">
              <button onClick={() => setCurrentPly(0)}>Start</button>
              <button onClick={() => setCurrentPly((v) => Math.max(0, v - 1))}>Prev</button>
              <span>
                {currentPly} / {moves.length}
              </span>
              <button onClick={() => setCurrentPly((v) => Math.min(moves.length, v + 1))}>
                Next
              </button>
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
                  <p>
                    {summary.opening
                      ? `${summary.eco} • ${summary.opening}`
                      : 'Unknown / not in slim opening list'}
                  </p>
                </div>

                <div className="summary-card">
                  <h3>White accuracy</h3>
                  <p>{summary.white.accuracy}%</p>
                </div>

                <div className="summary-card">
                  <h3>Black accuracy</h3>
                  <p>{summary.black.accuracy}%</p>
                </div>
              </div>

              <div className="counts-grid">
                <div>
                  {LABELS.map((label) => (
                    <div key={`w-${label}`} className="count-row">
                      <span>White {label}</span>
                      <strong>{summary.white.counts[label]}</strong>
                    </div>
                  ))}
                </div>

                <div>
                  {LABELS.map((label) => (
                    <div key={`b-${label}`} className="count-row">
                      <span>Black {label}</span>
                      <strong>{summary.black.counts[label]}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="move-list">
                {moves.map((move, idx) => (
                  <button
                    key={`${move.ply}-${move.uci}`}
                    className={`move-item ${currentPly === idx + 1 ? 'selected' : ''}`}
                    onClick={() => setCurrentPly(idx + 1)}
                  >
                    <div>
                      <strong>
                        {move.moveNumber}
                        {move.color === 'w' ? '.' : '...'} {move.san}
                      </strong>
                      <div className="mini">
                        Best: {move.bestMove ?? '—'} | CPL: {move.centipawnLoss ?? '—'}
                      </div>
                    </div>
                    <span className={`badge badge-${move.label.toLowerCase()}`}>
                      {move.label}
                    </span>
                  </button>
                ))}
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
