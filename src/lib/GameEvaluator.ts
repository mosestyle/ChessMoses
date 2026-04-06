import BrowserEngine, { type EngineEvalResult } from './BrowserEngine';
import { getCloudEvaluation } from './cloudEvaluate';

type TimelineNode = {
  fenBefore: string;
  fenAfter: string;
  uci: string;
};

type GameEvaluatorOptions = {
  initialFen: string;
  timeline: TimelineNode[];
  workerPath: string;
  engineDepth: number;
  engineTimeLimitMs?: number;
  multiPv: number;
  maxEngineCount?: number;
  onProgress?: (progress: {
    done: number;
    total: number;
    cloudHits: number;
    localHits: number;
  }) => void;
  verbose?: boolean;
};

export type GameEvaluationSummary = {
  results: EngineEvalResult[];
  cloudHits: number;
  localHits: number;
};

export type GameEvaluator = {
  evaluate: () => Promise<GameEvaluationSummary>;
  abort: () => void;
};

export default function createGameEvaluator(options: GameEvaluatorOptions): GameEvaluator {
  const controller = new AbortController();

  async function evaluate(): Promise<GameEvaluationSummary> {
    const positions = [options.initialFen, ...options.timeline.map((node) => node.fenAfter)];
    const results: EngineEvalResult[] = new Array(positions.length);

    let done = 0;
    let cloudHits = 0;
    let localHits = 0;

    function reportProgress(progressDone = done) {
      options.onProgress?.({
        done: progressDone,
        total: positions.length,
        cloudHits,
        localHits
      });
    }

    let cutoffIndex = 0;

    for (let i = 0; i < positions.length; i++) {
      if (controller.signal.aborted) throw new Error('aborted');

      try {
        const cloud = await getCloudEvaluation(positions[i], options.multiPv);
        if (!cloud) break;
        if (cloud.lineCount < options.multiPv) break;

        results[i] = cloud.result;
        cloudHits += 1;
        done += 1;
        cutoffIndex = i + 1;
        reportProgress();
      } catch {
        break;
      }
    }

    const evaluatedCount = results.filter(Boolean).length;
    const engineCount = Math.min(
      options.maxEngineCount || 1,
      (positions.length - evaluatedCount) + 1
    );

    let enginesResting = 0;
    let positionIndex = Math.max(evaluatedCount - 1, 0);

    return await new Promise<GameEvaluationSummary>((resolve, reject) => {
      const engines: BrowserEngine[] = [];

      function finishIfDone() {
        if (enginesResting === engineCount) {
          resolve({ results, cloudHits, localHits });
        }
      }

      function evaluateNextPosition(engine: BrowserEngine) {
        const currentIndex = positionIndex;

        if (positionIndex >= positions.length) {
          engine.terminate();
          enginesResting += 1;
          finishIfDone();
          return;
        }

        if (results[currentIndex]) {
          positionIndex += 1;
          evaluateNextPosition(engine);
          return;
        }

        const movesSoFar = options.timeline
          .slice(0, currentIndex)
          .map((node) => node.uci);

        engine.setPosition(options.initialFen, movesSoFar);

        engine.evaluate(
          positions[currentIndex],
          options.engineDepth,
          options.multiPv,
          options.engineTimeLimitMs,
          (line) => {
            const localProgress = line.depth === 0 ? 1 : line.depth / options.engineDepth;
            reportProgress(done + localProgress);
          }
        ).then((result) => {
          results[currentIndex] = result;
          localHits += 1;
          done += 1;
          reportProgress();
          evaluateNextPosition(engine);
        }).catch((error) => {
          reject(error);
        });

        positionIndex += 1;
      }

      for (let i = 0; i < engineCount; i++) {
        const engine = new BrowserEngine(options.workerPath);
        engines.push(engine);

        if (options.verbose) {
          engine.onMessage(console.log);
        }

        engine.onError((error) => {
          reject(new Error(error));
        });

        evaluateNextPosition(engine);
      }

      controller.signal.addEventListener('abort', () => {
        engines.forEach((engine) => engine.terminate());
        reject(new Error('aborted'));
      });
    });
  }

  return {
    evaluate,
    abort: () => controller.abort()
  };
}
