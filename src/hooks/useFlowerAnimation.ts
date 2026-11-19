import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  MOTION_PRESETS,
  type MotionConfig,
} from '../config/motion';
import { clamp01 } from '../utils/math';

const UI_INTERVAL_MS = 100;

export interface FlowerFrameSnapshot {
  openness: number;
  frameIndex: number;
}

export type FlowerFrameListener = (snapshot: FlowerFrameSnapshot) => void;

export interface FlowerAnimationOptions {
  frameCount: number;
  initialOpenness?: number;
  motion?: MotionConfig;
}

export interface FlowerAnimationController {
  /** 提供给滑块/状态文字的低频 UI 值；Canvas 通过 subscribe 取高频帧。 */
  openness: number;
  targetOpennessRef: RefObject<number>;
  smoothOpennessRef: RefObject<number>;
  frameIndexRef: RefObject<number>;
  setTarget: (value: number) => void;
  seek: (value: number) => void;
  subscribe: (listener: FlowerFrameListener) => () => void;
}

/**
 * 手势/手动共用的花朵动画控制器。
 *
 * - targetOpenness 可以由手势或滑块写入。
 * - smoothOpenness 使用基于 deltaTime 的指数平滑 + 最大速度限制。
 * - Canvas 通过 subscribe 接收帧变化，React 不参与逐帧渲染。
 * - 视觉方向约定：manifest 已归一化为 closed-to-open，
 *   因此 0 -> 首帧，1 -> 末帧。
 */
export function useFlowerAnimation({
  frameCount,
  initialOpenness = 0,
  motion = MOTION_PRESETS.natural,
}: FlowerAnimationOptions): FlowerAnimationController {
  const initial = clamp01(initialOpenness);
  const [openness, setOpenness] = useState(initial);
  const targetRef = useRef(initial);
  const smoothRef = useRef(initial);
  const frameIndexRef = useRef(0);
  const frameCountRef = useRef(frameCount);
  const motionRef = useRef(motion);
  const listenersRef = useRef(new Set<FlowerFrameListener>());
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);
  const lastUiRef = useRef(0);

  frameCountRef.current = frameCount;
  motionRef.current = motion;

  const publishUi = useCallback((value: number, force = false) => {
    const now = performance.now();
    if (!force && now - lastUiRef.current < UI_INTERVAL_MS) return;
    lastUiRef.current = now;
    setOpenness(value);
  }, []);

  const publishFrame = useCallback(
    (value: number, force = false) => {
      const count = frameCountRef.current;
      const nextIndex =
        count > 0
          ? Math.min(count - 1, Math.max(0, Math.round(value * (count - 1))))
          : 0;

      publishUi(value, force);

      if (nextIndex === frameIndexRef.current && !force) return;
      frameIndexRef.current = nextIndex;
      const snapshot: FlowerFrameSnapshot = {
        openness: value,
        frameIndex: nextIndex,
      };
      for (const listener of listenersRef.current) listener(snapshot);
    },
    [publishUi],
  );

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== null || frameCountRef.current < 1) return;
    lastTimeRef.current = performance.now();

    const step = (now: number) => {
      rafRef.current = null;
      const config = motionRef.current;
      const deltaSeconds = Math.min(
        config.maxDeltaTime,
        Math.max(0, (now - lastTimeRef.current) / 1000),
      );
      lastTimeRef.current = now;

      const target = clamp01(targetRef.current);
      let current = smoothRef.current;
      const diff = target - current;

      if (Math.abs(diff) <= config.deadBand) {
        // 死区：静止手势不产生连续的亚像素帧变化。
        current = target;
      } else {
        const alpha = 1 - Math.exp(-deltaSeconds / config.smoothingTau);
        const desiredStep = diff * alpha;
        // 限制最大速度，避免快速手势让花朵瞬移。
        const maxStep = config.maxOpennessSpeed * deltaSeconds;
        current +=
          Math.sign(diff) * Math.min(Math.abs(desiredStep), maxStep);
      }

      if (Math.abs(target - current) <= config.settleThreshold) {
        current = target;
      }
      current = clamp01(current);
      smoothRef.current = current;
      publishFrame(current);

      if (Math.abs(target - current) > config.settleThreshold) {
        rafRef.current = window.requestAnimationFrame(step);
      }
    };

    rafRef.current = window.requestAnimationFrame(step);
  }, [publishFrame]);

  const setTarget = useCallback(
    (value: number) => {
      const next = clamp01(value);
      targetRef.current = next;
      if (frameCountRef.current < 1) return;

      if (
        Math.abs(next - smoothRef.current) <=
        motionRef.current.settleThreshold
      ) {
        smoothRef.current = next;
        publishFrame(next);
        return;
      }
      startLoop();
    },
    [publishFrame, startLoop],
  );

  const seek = useCallback(
    (value: number) => {
      const next = clamp01(value);
      stopLoop();
      targetRef.current = next;
      smoothRef.current = next;
      publishFrame(next, true);
    },
    [publishFrame, stopLoop],
  );

  const subscribe = useCallback((listener: FlowerFrameListener) => {
    listenersRef.current.add(listener);
    const count = frameCountRef.current;
    const frameIndex =
      count > 0
        ? Math.min(
            count - 1,
            Math.max(0, Math.round(smoothRef.current * (count - 1))),
          )
        : 0;
    listener({ openness: smoothRef.current, frameIndex });
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    // 序列帧从 0 变为 120 时，确保 Canvas 收到一次有效帧。
    publishFrame(smoothRef.current, true);
    if (
      frameCount > 0 &&
      Math.abs(targetRef.current - smoothRef.current) >
        motionRef.current.settleThreshold
    ) {
      startLoop();
    }
  }, [frameCount, publishFrame, startLoop]);

  useEffect(() => {
    return () => {
      stopLoop();
      listenersRef.current.clear();
    };
  }, [stopLoop]);

  return {
    openness,
    targetOpennessRef: targetRef,
    smoothOpennessRef: smoothRef,
    frameIndexRef,
    setTarget,
    seek,
    subscribe,
  };
}
