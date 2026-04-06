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
  multiPv: number;
  maxEngineCount?: number;
  onProgress?: (progress: {
    done: number;
    total: number;
    cloudHits: number;
    localHits: number;
  }) => void;
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

function getRecommendedEngineCount(maxEngineCount?: number) {
  const hardware = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 2;

  const isMobile =
    typeof navigator !== 'undefined'
    && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  const safeDefault = isMobile ? 1 : Math.min(2, Math.max(1, hardware - 1));
  return Math.max(1, Math.min(maxEngineCount ?? safeDefault, safeDefault));
}

export default function createGameEvaluator(options: GameEvaluatorOptions): GameEvaluator {
  const controller = new AbortController();
  const { signal } = controller;

  async function evaluate(): Promise<GameEvaluationSummary> {
    const positions = [options.initialFen, ...options.timeline.map((node) => node.fenAfter)];
    const results: EngineEvalResult[] = new Array(positions.length);

    let done = 0;
    let cloudHits = 0;
    let localHits = 0;

    function reportProgress() {
      options.onProgress?.({
        done,
        total: positions.length,
        cloudHits,
        localHits
      });
    }

    let cutoffIndex = 0;

    for (let i = 0; i < positions.length; i++) {
      if (signal.aborted) throw new Error('aborted');

      try {
        const cloud = await getCloudEvaluation(positions[i], options.multiPv);

        if (!cloud) break;
        if (cloud.lineCount < 1) break;

        results[i] = cloud.result;
        cloudHits += 1;
        done += 1;
        cutoffIndex = i + 1;
        reportProgress();
      } catch {
        break;
      }
    }

    const remainingIndices = positions
      .map((_, index) => index)
      .slice(cutoffIndex);

    if (!remainingIndices.length) {
      return { results, cloudHits, localHits };
    }

    const engineCount = Math.min(
      getRecommendedEngineCount(options.maxEngineCount),
      Math.max(1, remainingIndices.length)
    );

    let enginesResting = 0;
    let positionIndex = Math.max(cutoffIndex - 1, 0);

    return await new Promise<GameEvaluationSummary>((resolve, reject) => {
      const engines: BrowserEngine[] = [];

      function finishIfDone() {
        if (enginesResting === engineCount) {
          resolve({ results, cloudHits, localHits });
        }
      }

      function evaluateNextPosition(engine: BrowserEngine) {
        const currentIndex = positionIndex;

        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }

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
          3000,
          (line) => {
            const localProgress = line.depth === 0 ? 1 : line.depth / options.engineDepth;
            const fractionalDone = done - localHits + localHits + localProgress;
            options.onProgress?.({
              done: fractionalDone,
              total: positions.length,
              cloudHits,
              localHits
            });
          }
        ).then((result) => {
          if (signal.aborted) return;

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
