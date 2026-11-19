import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

export interface CameraPipController {
  supported: boolean;
  active: boolean;
  error: string | null;
  /** 页面里播放的合成视频；PiP 也直接使用它。 */
  videoRef: RefObject<HTMLVideoElement | null>;
  toggle: () => void;
  exit: () => Promise<void>;
}

const COMPOSITE_FPS = 24;

function supportsPictureInPicture(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.pictureInPictureEnabled &&
      typeof HTMLVideoElement.prototype.requestPictureInPicture ===
        'function' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function',
  );
}

/**
 * 直接把「原始视频帧 + 节点」合成为新的 MediaStream。
 *
 * 页面预览和原生 PiP 播放的是同一个合成 video，因此：
 * - 页面里不再需要独立的节点 canvas；
 * - 浏览器自带 PiP 图标和页面里的「画中画」按钮都带节点；
 * - 镜像只发生在合成 canvas 里，页面和 PiP 方向一致。
 */
export function useCameraPip(
  sourceVideoRef: RefObject<HTMLVideoElement | null>,
  landmarksRef: RefObject<NormalizedLandmark[] | null>,
  enabled: boolean,
  visible: boolean,
): CameraPipController {
  const [supported] = useState(supportsPictureInPicture);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastDrawRef = useRef(0);
  const activeRef = useRef(false);

  const stopDrawing = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const drawComposite = useCallback(() => {
    const source = sourceVideoRef.current;
    const canvas = canvasRef.current;
    if (!source || !canvas) return;

    const sourceWidth = source.videoWidth;
    const sourceHeight = source.videoHeight;
    if (!sourceWidth || !sourceHeight) return;

    if (canvas.width !== sourceWidth || canvas.height !== sourceHeight) {
      canvas.width = sourceWidth;
      canvas.height = sourceHeight;
    }

    const context = canvas.getContext('2d');
    if (!context) return;

    const width = canvas.width;
    const height = canvas.height;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#0d0c0b';
    context.fillRect(0, 0, width, height);

    // 视频和节点在同一个镜像坐标系里绘制。
    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(source, 0, 0, width, height);

    const landmarks = landmarksRef.current;
    if (landmarks && landmarks.length >= 21) {
      const project = (point: NormalizedLandmark) => ({
        x: point.x * width,
        y: point.y * height,
      });
      const pointAt = (index: number) => {
        const point = landmarks[index];
        return point ? project(point) : null;
      };

      const unit = Math.max(0.8, width / 1280);
      context.lineCap = 'round';
      context.lineWidth = Math.max(1.8, 2.4 * unit);
      context.strokeStyle = 'rgba(247, 244, 240, 0.76)';

      for (const connection of HandLandmarker.HAND_CONNECTIONS) {
        const start = pointAt(connection.start);
        const end = pointAt(connection.end);
        if (!start || !end) continue;
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }

      for (let index = 0; index < landmarks.length; index += 1) {
        const point = pointAt(index);
        if (!point) continue;
        const isTip = index === 4 || index === 8;
        const isAnchor = index === 0 || index === 9;
        const radius = Math.max(
          3.2,
          (isTip ? 7.4 : isAnchor ? 6.2 : 4.4) * unit,
        );
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = isTip
          ? '#d98aa0'
          : isAnchor
            ? '#f7f4f0'
            : 'rgba(247, 244, 240, 0.86)';
        context.fill();
        if (isTip) {
          context.lineWidth = Math.max(1, unit);
          context.strokeStyle = 'rgba(48, 43, 41, 0.38)';
          context.stroke();
        }
      }
    }

    context.restore();
  }, [landmarksRef, sourceVideoRef]);

  const startDrawing = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = (now: number) => {
      rafRef.current = null;
      if (!enabled) return;
      if (now - lastDrawRef.current >= 1000 / COMPOSITE_FPS) {
        lastDrawRef.current = now;
        drawComposite();
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }, [drawComposite, enabled]);

  const ensureComposite = useCallback(() => {
    const source = sourceVideoRef.current;
    const display = videoRef.current;
    if (!source || !display) return false;

    if (!canvasRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = source.videoWidth || 1280;
      canvas.height = source.videoHeight || 720;
      canvas.className = 'camera-composite-canvas';
      canvasRef.current = canvas;
    }

    if (!streamRef.current) {
      streamRef.current = canvasRef.current.captureStream(COMPOSITE_FPS);
    }

    if (display.srcObject !== streamRef.current) {
      display.srcObject = streamRef.current;
    }

    drawComposite();
    void display.play().catch(() => undefined);
    return true;
  }, [drawComposite, sourceVideoRef]);

  const cleanup = useCallback(() => {
    stopDrawing();
    activeRef.current = false;
    setActive(false);

    const display = videoRef.current;
    if (display) {
      if (document.pictureInPictureElement === display) {
        void document.exitPictureInPicture().catch(() => undefined);
      }
      display.pause();
      display.srcObject = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    canvasRef.current = null;
  }, [stopDrawing]);

  const exit = useCallback(async () => {
    activeRef.current = false;
    setActive(false);
    const display = videoRef.current;
    if (display && document.pictureInPictureElement === display) {
      try {
        await document.exitPictureInPicture();
      } catch {
        // 浏览器可能已经关闭 PiP。
      }
    }
  }, []);

  const enter = useCallback(async () => {
    if (!supported) {
      setError('当前浏览器不支持画中画。');
      return;
    }

    const display = videoRef.current;
    if (!display || !display.srcObject) {
      setError('请先开启摄像头，等待画面出现后再进入画中画。');
      return;
    }

    try {
      setError(null);
      activeRef.current = true;
      setActive(true);
      void display.play().catch(() => undefined);
      await display.requestPictureInPicture();
    } catch {
      activeRef.current = false;
      setActive(false);
      setError('画中画启动失败，请确认浏览器允许画中画后重试。');
    }
  }, [supported]);

  const toggle = useCallback(() => {
    if (activeRef.current) {
      void exit();
    } else {
      void enter();
    }
  }, [enter, exit]);

  useEffect(() => {
    const display = videoRef.current;
    if (!display) return;

    const handleEnter = () => {
      activeRef.current = true;
      setActive(true);
      setError(null);
    };
    const handleLeave = () => {
      activeRef.current = false;
      setActive(false);
    };

    display.addEventListener('enterpictureinpicture', handleEnter);
    display.addEventListener('leavepictureinpicture', handleLeave);
    return () => {
      display.removeEventListener('enterpictureinpicture', handleEnter);
      display.removeEventListener('leavepictureinpicture', handleLeave);
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      cleanup();
      return;
    }

    const source = sourceVideoRef.current;
    if (!source) return;

    const prepare = () => {
      ensureComposite();
    };

    if (source.readyState >= 1) {
      prepare();
    } else {
      source.addEventListener('loadedmetadata', prepare, { once: true });
    }

    return () => {
      source.removeEventListener('loadedmetadata', prepare);
    };
  }, [cleanup, enabled, ensureComposite, sourceVideoRef]);

  // 主花朵页面不显示摄像头窗口时，停止不必要的合成绘制；
  // 但 PiP 正在使用时仍需继续合成。
  useEffect(() => {
    if (!enabled) return;
    if (visible || active) {
      ensureComposite();
      drawComposite();
      startDrawing();
    } else {
      stopDrawing();
    }
  }, [
    active,
    drawComposite,
    enabled,
    ensureComposite,
    startDrawing,
    stopDrawing,
    visible,
  ]);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    supported,
    active,
    error,
    videoRef,
    toggle,
    exit,
  };
}
