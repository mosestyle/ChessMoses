import { Chess } from 'chess.js';
import type { EnginePositionResult } from './analyzer';

export type EngineEvalResult = EnginePositionResult & {
  cacheHit: boolean;
};

type PendingRequest = {
  resolve: (result: EngineEvalResult) => void;
  reject: (error: Error) => void;
  fen: string;
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
  private currentFen = new Chess().fen();
  private evaluating = false;

  constructor(workerPath: string) {
    this.worker = new Worker(workerPath);
    this.worker.postMessage('uci');
    this.setPosition(this.currentFen);
  }

  private makeCacheKey(fen: string, depth: number, multiPv: number) {
    return `${fen}__d${depth}__m${multiPv}`;
  }

  terminate() {
    try {
      this.worker.postMessage('quit');
    } catch {
      this.worker.terminate();
    }
  }

  setOption(option: string, value: string) {
    this.worker.postMessage(`setoption name ${option} value ${value}`);
    return this;
  }

  setLineCount(lines: number) {
    this.setOption('MultiPV', String(lines));
    return this;
  }

  setThreadCount(threads: number) {
    this.setOption('Threads', String(threads));
    return this;
  }

  setPosition(fen: string, uciMoves?: string[]) {
    if (uciMoves?.length) {
      this.worker.postMessage(`position fen ${fen} moves ${uciMoves.join(' ')}`);

      const board = new Chess(fen);
      for (const uciMove of uciMoves) {
        board.move(uciMove);
      }

      this.currentFen = board.fen();
      return this;
    }

    this.worker.postMessage(`position fen ${fen}`);
    this.currentFen = fen;
    return this;
  }

  clearCache() {
    this.cache.clear();
  }

  async stop() {
    if (!this.evaluating || !this.pending) return;

    const resolve = this.pending.resolve;
    const partial: EngineEvalResult = {
      fen: this.pending.fen,
      bestMove: this.pending.bestMove,
      bestEvalCp: this.pending.bestEvalCp,
      topLines: this.pending.topLines,
      cacheHit: false
    };

    this.worker.postMessage('stop');

    if (this.pending.timer !== null) {
      window.clearTimeout(this.pending.timer);
    }

    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.pending = null;
    this.evaluating = false;

    resolve(partial);
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

    await this.stop();

    this.setPosition(fen);
    this.setLineCount(multiPv);

    return new Promise<EngineEvalResult>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        fen,
        bestMove: null,
        bestEvalCp: null,
        topLines: [],
        timer: null
      };

      this.pending = pending;
      this.evaluating = true;

      this.worker.onmessage = (event: MessageEvent) => {
        if (!this.pending) return;

        const line = String(event.data);

        if (line.startsWith('info depth') && !line.includes('currmove')) {
          const moveMatch = line.match(/ pv\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
          const cpMatch = line.match(/ score cp (-?\d+)/);
          const mateMatch = line.match(/ score mate (-?\d+)/);
          const mpvMatch = line.match(/ multipv (\d+)/);

          const move = moveMatch ? moveMatch[1] : undefined;
          const cp = cpMatch ? Number(cpMatch[1]) : undefined;
          const mate = mateMatch ? Number(mateMatch[1]) : undefined;
          const mpv = mpvMatch ? Number(mpvMatch[1]) : 1;

          if (move) {
            let normalizedCp = cp;
            let normalizedMate = mate;

            if (this.currentFen.includes(' b ')) {
              if (typeof normalizedCp === 'number') normalizedCp = -normalizedCp;
              if (typeof normalizedMate === 'number') normalizedMate = -normalizedMate;
            }

            this.pending.topLines[mpv - 1] = {
              move,
              cp: normalizedCp,
              mate: normalizedMate
            };

            if (mpv === 1) {
              if (typeof normalizedCp === 'number') this.pending.bestEvalCp = normalizedCp;
              else if (typeof normalizedMate === 'number') this.pending.bestEvalCp = Math.sign(normalizedMate) * 10000;
            }
          }
        }

        if (line.startsWith('bestmove') || line.includes('depth 0')) {
          const parts = line.split(' ');
          if (line.startsWith('bestmove')) {
            this.pending.bestMove = parts.length > 1 ? parts[1] : null;
          }

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

          if (this.pending.timer !== null) {
            window.clearTimeout(this.pending.timer);
          }

          const resolveNow = this.pending.resolve;
          this.worker.onmessage = null;
          this.worker.onerror = null;
          this.pending = null;
          this.evaluating = false;
          resolveNow(result);
        }
      };

      this.worker.onerror = () => {
        if (!this.pending) return;

        const rejectNow = this.pending.reject;

        if (this.pending.timer !== null) {
          window.clearTimeout(this.pending.timer);
        }

        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.pending = null;
        this.evaluating = false;

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
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.pending = null;
        this.evaluating = false;
        resolveNow(result);
      }, 8000);

      this.worker.postMessage(`go depth ${depth}`);
    });
  }
}
