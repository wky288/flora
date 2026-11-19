import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FrameLoadProgress,
  LoadedFlowerSequence,
} from '../types/flower';
import {
  clearFlowerSequenceCache,
  preloadFlowerSequence,
} from '../utils/frameLoader';

interface UseFlowerFramesResult {
  sequence: LoadedFlowerSequence | null;
  progress: FrameLoadProgress;
  error: string | null;
  isLoading: boolean;
  retry: () => void;
}

const EMPTY_PROGRESS: FrameLoadProgress = { loaded: 0, total: 0, percent: 0 };

/**
 * 加载并缓存一整套花朵序列帧。
 * 全部帧解码完成后才返回 sequence，确保播放阶段不会触发新的图片请求。
 */
export function useFlowerFrames(manifestUrl: string): UseFlowerFramesResult {
  const [sequence, setSequence] = useState<LoadedFlowerSequence | null>(null);
  const [progress, setProgress] = useState<FrameLoadProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastProgressAtRef = useRef(0);

  useEffect(() => {
    let active = true;

    setSequence(null);
    setError(null);
    setProgress(EMPTY_PROGRESS);
    lastProgressAtRef.current = 0;

    const handle = preloadFlowerSequence(manifestUrl, (nextProgress) => {
      if (!active) return;
      // 逐帧 setState 会让加载期间产生 120 次 React 更新；
      // 进度条只需约 10fps，最终 100% 在 sequence resolve 后强制提交。
      const now = performance.now();
      if (
        nextProgress.percent < 100 &&
        now - lastProgressAtRef.current < 100
      ) {
        return;
      }
      lastProgressAtRef.current = now;
      setProgress(nextProgress);
    });

    handle.promise
      .then((loaded) => {
        if (!active) return;
        setSequence(loaded);
        setProgress({
          loaded: loaded.images.length,
          total: loaded.images.length,
          percent: 100,
        });
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      });

    return () => {
      active = false;
      handle.unsubscribe();
    };
  }, [manifestUrl, attempt]);

  const retry = useCallback(() => {
    clearFlowerSequenceCache(manifestUrl);
    setAttempt((value) => value + 1);
  }, [manifestUrl]);

  return {
    sequence,
    progress,
    error,
    isLoading: sequence === null && error === null,
    retry,
  };
}
