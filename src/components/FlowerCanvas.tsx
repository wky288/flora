import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FlowerAnimationController } from '../hooks/useFlowerAnimation';
import type { LoadedFlowerSequence } from '../types/flower';

interface FlowerCanvasProps {
  sequence: LoadedFlowerSequence | null;
  animation: FlowerAnimationController;
}

/**
 * Canvas 2D 序列帧画布。
 *
 * 帧变化通过 animation.subscribe 直接驱动 Canvas，React 不参与逐帧渲染。
 * 画布尺寸跟随容器与 devicePixelRatio（上限 2）变化，画面始终居中、等比完整显示。
 */
export function FlowerCanvas({ sequence, animation }: FlowerCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sequenceRef = useRef<LoadedFlowerSequence | null>(null);
  const frameIndexRef = useRef(0);
  const lastFrameRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const current = sequenceRef.current;
    if (!canvas || !current) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const frame =
      current.images[frameIndexRef.current] ?? lastFrameRef.current;
    if (!frame || frame.naturalWidth === 0) return;
    lastFrameRef.current = frame;

    const { manifest } = current;
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    context.clearRect(0, 0, canvasWidth, canvasHeight);
    // 序列帧带 alpha；先铺页面底色，保证画布不透明且帧外没有矩形色差。
    context.fillStyle = '#efeae4';
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    // 等比 contain：预留整个画面，不裁切花朵。
    const scale = Math.min(
      canvasWidth / manifest.width,
      canvasHeight / manifest.height,
    );
    const drawWidth = manifest.width * scale;
    const drawHeight = manifest.height * scale;
    const x = (canvasWidth - drawWidth) / 2;
    const y = (canvasHeight - drawHeight) / 2;

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'medium';
    context.drawImage(frame, x, y, drawWidth, drawHeight);
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    sequenceRef.current = sequence;
    frameIndexRef.current = animation.frameIndexRef.current ?? 0;
    if (sequence) draw();
  }, [animation.frameIndexRef, draw, sequence]);

  useEffect(() => {
    if (!sequence) return;

    const unsubscribe = animation.subscribe((snapshot) => {
      frameIndexRef.current = snapshot.frameIndex;
      scheduleDraw();
    });
    return unsubscribe;
  }, [animation.subscribe, scheduleDraw, sequence]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // 同步绘制，避免尺寸变化后出现一帧空白。
      draw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    window.addEventListener('resize', resize);
    resize();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [draw]);

  return (
    <div className="flower-canvas" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label="牡丹花朵序列帧画面" />
    </div>
  );
}
