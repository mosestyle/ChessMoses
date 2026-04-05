import { Chess } from 'chess.js';
import type { EnginePositionResult } from './analyzer';

export type EngineEvalResult = EnginePositionResult & {
  cacheHit: boolean;
};

type PendingRequest = {
  resolve: (result: EngineEvalResult) => void;
  reject: (error: Error) => void;
  fen: string;
  depth: number;
  multiPv: number;
  bestMove: string | null;
  bestEvalCp: number | null;
  topLines: { move: string; cp?: number; mate?: number }[];
  timer: number | null;
};

function synthesizeTerminalEngineResult(fen: string): EngineEvalResult | null {
  try {
    const chess = new Chess(fen);

    if (!chess.isGameOver()) return null;

    if (chess.isCheckmate()) {
      const bestEvalCp = chess.turn() === 'b' ? 10000 : -10000;
      return {
        fen,
        bestMove: null,
        bestEvalCp,
        topLines: [],
        cacheHit: false
      };
    }

    return {
      fen,
      bestMove: null,
      bestEvalCp: 0,
      topLines: [],
      cacheHit: false
    };
  } catch {
    return null;
  }
}

export default class BrowserEngine {
  private worker: Worker;
  private cache = new Map<string, EnginePositionResult>();
  private pending: PendingRequest | null = null;

  constructor(workerPath: string) {
    this.worker = new Worker(workerPath);
    this.worker.postMessage('uci');
  }

  private makeCacheKey(fen: string, depth: number, multiPv: number) {
    return `${fen}__d${depth}__m${multiPv}`;
  }

  private cleanupPending() {
    if (!this.pending) return;

    if (this.pending.timer !== null) {
      window.clearTimeout(this.pending.timer);
    }

    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.pending = null;
  }

  terminate() {
    this.cleanupPending();
    this.worker.terminate();
  }

  stop() {
    if (!this.pending) return;

    const partial: EngineEvalResult = {
      fen: this.pending.fen,
      bestMove: this.pending.bestMove,
      bestEvalCp: this.pending.bestEvalCp,
      topLines: this.pending.topLines,
      cacheHit: false
    };

    const resolve = this.pending.resolve;
    this.worker.postMessage('stop');
    this.cleanupPending();
    resolve(partial);
  }

  clearCache() {
    this.cache.clear();
  }

  async evaluate(
    fen: string,
    depth: number,
    multiPv = 1
  ): Promise<EngineEvalResult> {
    const cacheKey = this.makeCacheKey(fen, depth, multiPv);
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return {
        ...cached,
        cacheHit: true
      };
    }

    const terminal = synthesizeTerminalEngineResult(fen);
    if (terminal) {
      this.cache.set(cacheKey, {
        fen: terminal.fen,
        bestMove: terminal.bestMove,
        bestEvalCp: terminal.bestEvalCp,
        topLines: terminal.topLines
      });
      return terminal;
    }

    this.stop();

    return new Promise<EngineEvalResult>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        fen,
        depth,
        multiPv,
        bestMove: null,
        bestEvalCp: null,
        topLines: [],
        timer: null
      };

      this.pending = pending;

      this.worker.onmessage = (event: MessageEvent) => {
        if (!this.pending) return;

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
            this.pending.topLines[mpv - 1] = { move, cp, mate };

            if (mpv === 1) {
              if (typeof cp === 'number') this.pending.bestEvalCp = cp;
              else if (typeof mate === 'number') this.pending.bestEvalCp = Math.sign(mate) * 10000;
            }
          }
        }

        if (line.startsWith('bestmove')) {
          const parts = line.split(' ');
          this.pending.bestMove = parts.length > 1 ? parts[1] : null;

          const result: EngineEvalResult = {
            fen: this.pending.fen,
            bestMove: this.pending.bestMove,
            bestEvalCp: this.pending.bestEvalCp,
            topLines: this.pending.topLines.filter(Boolean),
            cacheHit: false
          };

          this.cache.set(cacheKey, {
            fen: result.fen,
            bestMove: result.bestMove,
            bestEvalCp: result.bestEvalCp,
            topLines: result.topLines
          });

          const resolveNow = this.pending.resolve;
          this.cleanupPending();
          resolveNow(result);
        }
      };

      this.worker.onerror = () => {
        if (!this.pending) return;
        const rejectNow = this.pending.reject;
        this.cleanupPending();
        rejectNow(new Error('Engine worker failed during evaluation.'));
      };

      pending.timer = window.setTimeout(() => {
        if (!this.pending) return;

        const result: EngineEvalResult = {
          fen: this.pending.fen,
          bestMove: this.pending.bestMove,
          bestEvalCp: this.pending.bestEvalCp,
          topLines: this.pending.topLines.filter(Boolean),
          cacheHit: false
        };

        this.cache.set(cacheKey, {
          fen: result.fen,
          bestMove: result.bestMove,
          bestEvalCp: result.bestEvalCp,
          topLines: result.topLines
        });

        const resolveNow = this.pending.resolve;
        this.cleanupPending();
        resolveNow(result);
      }, 6500);

      this.worker.postMessage('stop');
      this.worker.postMessage('ucinewgame');
      this.worker.postMessage(`setoption name MultiPV value ${multiPv}`);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${depth}`);
    });
  }
}
