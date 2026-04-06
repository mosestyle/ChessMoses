import BrowserEngine, { type EngineEvalResult } from './BrowserEngine';
import { getCloudEvaluation } from './cloudEvaluate';

type GameEvaluatorOptions = {
  fens: string[];
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
    const results: EngineEvalResult[] = new Array(options.fens.length);

    let done = 0;
    let cloudHits = 0;
    let localHits = 0;

    function reportProgress() {
      options.onProgress?.({
        done,
        total: options.fens.length,
        cloudHits,
        localHits
      });
    }

    let cutoffIndex = 0;

    for (let i = 0; i < options.fens.length; i++) {
      if (signal.aborted) throw new Error('aborted');

      try {
        const cloud = await getCloudEvaluation(options.fens[i], options.multiPv);

        if (!cloud) break;
        if (cloud.depth < options.engineDepth) break;
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

    const remainingIndices = options.fens
      .map((_, index) => index)
      .slice(cutoffIndex);

    if (!remainingIndices.length) {
      return { results, cloudHits, localHits };
    }

    const preferredEngineCount = Math.min(
      getRecommendedEngineCount(options.maxEngineCount),
      remainingIndices.length
    );

    async function runSequential(indices: number[]) {
      const engine = new BrowserEngine(options.workerPath);

      try {
        for (const index of indices) {
          if (signal.aborted) break;
          if (results[index]) continue;

          const result = await engine.evaluate(
            options.fens[index],
            options.engineDepth,
            options.multiPv
          );

          if (signal.aborted) break;

          results[index] = result;
          localHits += 1;
          done += 1;
          reportProgress();
        }
      } finally {
        engine.terminate();
      }
    }

    if (preferredEngineCount <= 1) {
      await runSequential(remainingIndices);
    } else {
      let queueIndex = 0;
      const engines = Array.from(
        { length: preferredEngineCount },
        () => new BrowserEngine(options.workerPath)
      );

      try {
        async function runEngine(engine: BrowserEngine) {
          while (queueIndex < remainingIndices.length) {
            if (signal.aborted) break;

            const index = remainingIndices[queueIndex];
            queueIndex += 1;

            const result = await engine.evaluate(
              options.fens[index],
              options.engineDepth,
              options.multiPv
            );

            if (signal.aborted) break;

            results[index] = result;
            localHits += 1;
            done += 1;
            reportProgress();
          }
        }

        await Promise.all(engines.map(runEngine));
      } catch {
        engines.forEach((engine) => engine.terminate());

        const unfinished = remainingIndices.filter((index) => !results[index]);
        if (!signal.aborted && unfinished.length) {
          await runSequential(unfinished);
        }
      } finally {
        engines.forEach((engine) => {
          try {
            engine.terminate();
          } catch {
            // ignore
          }
        });
      }
    }

    if (signal.aborted) throw new Error('aborted');

    return { results, cloudHits, localHits };
  }

  return {
    evaluate,
    abort: () => controller.abort()
  };
}
