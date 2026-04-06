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

    const engineCount = Math.min(
      options.maxEngineCount || 4,
      remainingIndices.length
    );

    const engines = Array.from(
      { length: engineCount },
      () => new BrowserEngine(options.workerPath)
    );

    let queueIndex = 0;

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

    try {
      await Promise.all(engines.map(runEngine));
    } finally {
      engines.forEach((engine) => engine.terminate());
    }

    if (signal.aborted) throw new Error('aborted');

    return { results, cloudHits, localHits };
  }

  return {
    evaluate,
    abort: () => controller.abort()
  };
}
