import { Chess } from 'chess.js';
import type { EnginePositionResult } from './analyzer';

export type EngineEvalResult = EnginePositionResult & {
  cacheHit: boolean;
};

type EngineLine = {
  move: string;
  cp?: number;
  mate?: number;
};

type EvaluateOptions = {
  depth: number;
  timeLimitMs?: number;
  onEngineLine?: (line: {
    depth: number;
    index: number;
    cp?: number;
    mate?: number;
    move?: string;
  }) => void;
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
  private currentFen: string;
  private evaluating = false;
  private cache = new Map<string, EnginePositionResult>();

  constructor(workerPath: string) {
    this.worker = new Worker(workerPath);
    this.currentFen = new Chess().fen();

    this.worker.postMessage('uci');
    this.setPosition(this.currentFen);
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

  private makeCacheKey(fen: string, depth: number, multiPv: number, timeLimitMs?: number) {
    return `${fen}__d${depth}__m${multiPv}__t${timeLimitMs || 0}`;
  }

  private consumeLogs(
    command: string,
    endCondition: (message: string) => boolean,
    onLogReceived?: (message: string) => void
  ): Promise<string[]> {
    if (command) {
      this.worker.postMessage(command);
    }

    const worker = this.worker;
    const logMessages: string[] = [];

    return new Promise((resolve, reject) => {
      function onMessageReceived(event: MessageEvent) {
        const message = String(event.data);

        onLogReceived?.(message);
        logMessages.push(message);

        if (endCondition(message)) {
          worker.removeEventListener('message', onMessageReceived);
          worker.removeEventListener('error', onErrorReceived);
          resolve(logMessages);
        }
      }

      function onErrorReceived(event: ErrorEvent) {
        worker.removeEventListener('message', onMessageReceived);
        worker.removeEventListener('error', onErrorReceived);

        const details = [
          event.message || 'Unknown worker error',
          event.filename ? `File: ${event.filename}` : '',
          typeof event.lineno === 'number' ? `Line: ${event.lineno}` : '',
          typeof event.colno === 'number' ? `Column: ${event.colno}` : ''
        ].filter(Boolean).join(' | ');

        reject(new Error(details || 'Engine worker failed during evaluation.'));
      }

      worker.addEventListener('message', onMessageReceived);
      worker.addEventListener('error', onErrorReceived);
    });
  }

  async stop() {
    if (!this.evaluating) return;

    this.worker.postMessage('stop');

    try {
      await this.consumeLogs('', (message) => message.startsWith('bestmove'));
    } catch {
      // ignore
    }

    this.evaluating = false;
  }

  async evaluate(
    fen: string,
    depth: number,
    multiPv = 1,
    timeLimitMs?: number,
    onEngineLine?: EvaluateOptions['onEngineLine']
  ): Promise<EngineEvalResult> {
    const cacheKey = this.makeCacheKey(fen, depth, multiPv, timeLimitMs);
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

    const topLines: EngineLine[] = [];
    let bestMove: string | null = null;
    let bestEvalCp: number | null = null;

    const maxTimeArgument = timeLimitMs ? ` movetime ${timeLimitMs}` : '';

    this.evaluating = true;

    await this.consumeLogs(
      `go depth ${depth}${maxTimeArgument}`,
      (message) => message.startsWith('bestmove') || message.includes('depth 0'),
      (message) => {
        if (!message.startsWith('info depth')) return;
        if (message.includes('currmove')) return;

        const depthMatch = message.match(/(?<= depth )\d+/);
        const indexMatch = message.match(/(?<= multipv )\d+/);
        const scoreMatches = message.match(/ score (cp|mate) (-?\d+)/);
        const moveMatch = message.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);

        const infoDepth = parseInt(depthMatch?.[0] || '');
        if (Number.isNaN(infoDepth)) return;

        const infoIndex = parseInt(indexMatch?.[0] || '') || 1;

        let cp: number | undefined;
        let mate: number | undefined;

        if (scoreMatches?.[1] === 'cp') {
          cp = parseInt(scoreMatches[2]);
          if (this.currentFen.includes(' b ')) cp = -cp;
        } else if (scoreMatches?.[1] === 'mate') {
          mate = parseInt(scoreMatches[2]);
          if (this.currentFen.includes(' b ')) mate = -mate;
        }

        const move = moveMatch?.[1];

        if (move) {
          topLines[infoIndex - 1] = { move, cp, mate };

          if (infoIndex === 1) {
            bestMove = move;
            if (typeof cp === 'number') bestEvalCp = cp;
            else if (typeof mate === 'number') bestEvalCp = Math.sign(mate) * 10000;
          }
        }

        onEngineLine?.({
          depth: infoDepth,
          index: infoIndex,
          cp,
          mate,
          move
        });
      }
    );

    this.evaluating = false;

    const result: EngineEvalResult = {
      fen,
      bestMove,
      bestEvalCp,
      topLines: topLines.filter(Boolean),
      cacheHit: false
    };

    this.cache.set(cacheKey, {
      fen: result.fen,
      bestMove: result.bestMove,
      bestEvalCp: result.bestEvalCp,
      topLines: result.topLines
    });

    return result;
  }
}
