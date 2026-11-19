import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import {
  clamp01,
  getHandMetrics,
  isValidCalibration,
  mapRatioToOpenness,
  MIN_CALIBRATION_GAP,
  smoothValue,
  type Calibration,
} from '../utils/gesture';

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'loading'
  | 'ready'
  | 'error';

export type HandStatus = 'waiting' | 'tracking' | 'lost';

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: { mediaTime: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const BASE_URL = import.meta.env.BASE_URL;
const WASM_PATH = `${BASE_URL}mediapipe/wasm`;
const MODEL_PATH = `${BASE_URL}models/hand_landmarker.task`;
const DETECT_INTERVAL = 1000 / 24;
const UI_INTERVAL = 100;
const LOST_GRACE = 250;
const SMOOTHING = 0.22;
const DEAD_BAND = 0.006;

function cameraErrorMessage(error: unknown): string {
  const name =
    error instanceof DOMException
      ? error.name
      : typeof error === 'object' && error !== null && 'name' in error
        ? String((error as { name?: unknown }).name)
        : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝。请在浏览器地址栏允许摄像头访问后重试。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到摄像头。请连接摄像头后重试。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头无法读取，可能被其他应用占用。请关闭占用摄像头的程序后重试。';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return '当前摄像头不支持所需参数，请尝试更换摄像头。';
    case 'SecurityError':
      return '摄像头需要 HTTPS 或 localhost 环境才能使用。';
    default:
      return '无法打开摄像头，请检查设备连接和浏览器权限。';
  }
}

async function createHandLandmarker(): Promise<HandLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = {
    baseOptions: {
      modelAssetPath: MODEL_PATH,
      delegate: 'GPU' as const,
    },
    runningMode: 'VIDEO' as const,
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };

  try {
    return await HandLandmarker.createFromOptions(vision, options);
  } catch {
    // 笔记本/无 GPU 的浏览器回退到 CPU。
    return await HandLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' as const },
    });
  }
}

export interface HandGestureController {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  latestLandmarksRef: RefObject<NormalizedLandmark[] | null>;
  cameraStatus: CameraStatus;
  handStatus: HandStatus;
  error: string | null;
  recognitionError: string | null;
  pinch: number | null;
  palm: number | null;
  ratio: number | null;
  normalized: number | null;
  openness: number | null;
  calibration: Calibration | null;
  closedSample: number | null;
  openSample: number | null;
  calibrationError: string | null;
  isActive: boolean;
  start: () => Promise<void>;
  stop: () => void;
  recordClosed: () => void;
  recordOpen: () => void;
  resetCalibration: () => void;
}

export function useHandGesture(): HandGestureController {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const latestLandmarksRef = useRef<NormalizedLandmark[] | null>(null);

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [handStatus, setHandStatus] = useState<HandStatus>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [pinch, setPinch] = useState<number | null>(null);
  const [palm, setPalm] = useState<number | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [normalized, setNormalized] = useState<number | null>(null);
  const [openness, setOpenness] = useState<number | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [closedSample, setClosedSample] = useState<number | null>(null);
  const [openSample, setOpenSample] = useState<number | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);

  const cameraStatusRef = useRef<CameraStatus>('idle');
  const handStatusRef = useRef<HandStatus>('waiting');
  const mountedRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const runningRef = useRef(false);
  const startTokenRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const videoFrameRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const lastDetectRef = useRef(0);
  const lastPublishRef = useRef(0);
  const lastSeenRef = useRef(0);
  const lastRatioRef = useRef<number | null>(null);
  const smoothedRef = useRef(0);
  const hasValueRef = useRef(false);
  const calibrationRef = useRef<Calibration | null>(null);
  const closedSampleRef = useRef<number | null>(null);
  const openSampleRef = useRef<number | null>(null);
  const recognitionErrorRef = useRef(false);

  const updateCameraStatus = useCallback((next: CameraStatus) => {
    cameraStatusRef.current = next;
    if (mountedRef.current) setCameraStatus(next);
  }, []);

  const updateHandStatus = useCallback((next: HandStatus) => {
    handStatusRef.current = next;
    if (mountedRef.current) setHandStatus(next);
  }, []);

  const clearOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const drawLandmarks = useCallback((landmarks: NormalizedLandmark[]) => {
    const video = videoRef.current;
    const canvas = overlayRef.current;
    if (!video || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) return;

    // object-fit: contain 的内容区域。
    const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
    const drawWidth = videoWidth * scale;
    const drawHeight = videoHeight * scale;
    const offsetX = (rect.width - drawWidth) / 2;
    const offsetY = (rect.height - drawHeight) / 2;

    const project = (point: NormalizedLandmark) => ({
      x: offsetX + point.x * drawWidth,
      y: offsetY + point.y * drawHeight,
    });

    const pointAt = (index: number) => {
      const point = landmarks[index];
      return point ? project(point) : null;
    };

    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 1.2;
    context.strokeStyle = 'rgba(247, 244, 240, 0.72)';
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
      context.beginPath();
      context.arc(point.x, point.y, isTip ? 3.8 : isAnchor ? 3.2 : 2.2, 0, Math.PI * 2);
      context.fillStyle = isTip
        ? '#d98aa0'
        : isAnchor
          ? '#f7f4f0'
          : 'rgba(247, 244, 240, 0.82)';
      context.fill();
      if (isTip) {
        context.lineWidth = 1;
        context.strokeStyle = 'rgba(48, 43, 41, 0.35)';
        context.stroke();
      }
    }
  }, []);

  const drawLatestLandmarks = useCallback(() => {
    const landmarks = latestLandmarksRef.current;
    if (landmarks) {
      drawLandmarks(landmarks);
    } else {
      clearOverlay();
    }
  }, [clearOverlay, drawLandmarks]);

  // 摄像头窗口宽度变化时，节点画布必须跟随当前窗口重新绘制。
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => drawLatestLandmarks());
      observer.observe(canvas);
    }

    window.addEventListener('resize', drawLatestLandmarks);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', drawLatestLandmarks);
    };
  }, [drawLatestLandmarks]);

  const publishMetrics = useCallback(
    (
      nextPinch: number,
      nextPalm: number,
      nextRatio: number,
      nextNormalized: number,
      nextOpenness: number,
      force: boolean,
    ) => {
      const now = performance.now();
      if (!force && now - lastPublishRef.current < UI_INTERVAL) return;
      lastPublishRef.current = now;
      if (!mountedRef.current) return;
      setPinch(nextPinch);
      setPalm(nextPalm);
      setRatio(nextRatio);
      setNormalized(nextNormalized);
      setOpenness(nextOpenness);
    },
    [],
  );

  const handleResult = useCallback(
    (result: HandLandmarkerResult, now: number) => {
      if (recognitionErrorRef.current) {
        recognitionErrorRef.current = false;
        if (mountedRef.current) setRecognitionError(null);
      }

      const landmarks = result.landmarks?.[0];
      if (!landmarks || landmarks.length < 21) {
        latestLandmarksRef.current = null;
        clearOverlay();
        const recentlySeen =
          lastSeenRef.current > 0 && now - lastSeenRef.current < LOST_GRACE;
        updateHandStatus(
          recentlySeen
            ? 'tracking'
            : lastRatioRef.current === null
              ? 'waiting'
              : 'lost',
        );
        // 保持最后有效 openness，不因短暂丢失而回到 0。
        return;
      }

      const video = videoRef.current;
      const aspectRatio =
        video && video.videoHeight > 0
          ? video.videoWidth / video.videoHeight
          : 1;
      const metrics = getHandMetrics(landmarks, aspectRatio);
      if (!metrics.valid) {
        latestLandmarksRef.current = null;
        clearOverlay();
        const recentlySeen =
          lastSeenRef.current > 0 && now - lastSeenRef.current < LOST_GRACE;
        updateHandStatus(
          recentlySeen
            ? 'tracking'
            : lastRatioRef.current === null
              ? 'waiting'
              : 'lost',
        );
        return;
      }

      lastSeenRef.current = now;
      lastRatioRef.current = metrics.ratio;

      const mapped = mapRatioToOpenness(metrics.ratio, calibrationRef.current);
      let next: number;
      if (!hasValueRef.current) {
        next = mapped;
        hasValueRef.current = true;
      } else {
        const target =
          Math.abs(mapped - smoothedRef.current) < DEAD_BAND
            ? smoothedRef.current
            : mapped;
        next = smoothValue(smoothedRef.current, target, SMOOTHING);
      }

      // 两端吸附，便于验收时得到明确的 0 / 1。
      if (next < 0.015) next = 0;
      if (next > 0.985) next = 1;
      next = clamp01(next);
      smoothedRef.current = next;

      publishMetrics(
        metrics.pinch,
        metrics.palm,
        metrics.ratio,
        mapped,
        next,
        handStatusRef.current !== 'tracking',
      );
      updateHandStatus('tracking');
      latestLandmarksRef.current = landmarks;
      drawLandmarks(landmarks);
    },
    [clearOverlay, drawLandmarks, publishMetrics, updateHandStatus],
  );

  const detectOnce = useCallback(() => {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (!runningRef.current || !video || !landmarker) return;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

    const now = performance.now();
    if (now - lastDetectRef.current < DETECT_INTERVAL) return;
    // 同一个视频帧只推理一次。
    if (video.currentTime === lastVideoTimeRef.current) return;

    lastDetectRef.current = now;
    lastVideoTimeRef.current = video.currentTime;

    try {
      const result = landmarker.detectForVideo(video, now);
      handleResult(result, now);
    } catch {
      if (!recognitionErrorRef.current) {
        recognitionErrorRef.current = true;
        if (mountedRef.current) {
          setRecognitionError('手势识别暂时中断，正在自动重试。');
        }
      }
    }
  }, [handleResult]);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    const video = videoRef.current as FrameVideo | null;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (videoFrameRef.current !== null) {
      if (video?.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(videoFrameRef.current);
      }
      videoFrameRef.current = null;
    }
  }, []);

  const startLoop = useCallback(() => {
    const video = videoRef.current as FrameVideo | null;
    if (!video) return;
    runningRef.current = true;

    const tick = () => {
      if (!runningRef.current) return;
      detectOnce();
      if (!runningRef.current) return;
      if (video.requestVideoFrameCallback) {
        videoFrameRef.current = video.requestVideoFrameCallback(tick);
      } else {
        rafRef.current = window.requestAnimationFrame(tick);
      }
    };

    if (video.requestVideoFrameCallback) {
      videoFrameRef.current = video.requestVideoFrameCallback(tick);
    } else {
      rafRef.current = window.requestAnimationFrame(tick);
    }
  }, [detectOnce]);

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }, []);

  const closeLandmarker = useCallback(() => {
    const landmarker = landmarkerRef.current;
    landmarkerRef.current = null;
    if (landmarker) landmarker.close();
  }, []);

  const stop = useCallback(() => {
    startTokenRef.current += 1;
    stopLoop();
    stopStream();
    closeLandmarker();
    latestLandmarksRef.current = null;
    clearOverlay();
    hasValueRef.current = false;
    lastSeenRef.current = 0;
    lastRatioRef.current = null;
    smoothedRef.current = 0;
    recognitionErrorRef.current = false;

    if (!mountedRef.current) return;
    updateCameraStatus('idle');
    updateHandStatus('waiting');
    setError(null);
    setRecognitionError(null);
    setPinch(null);
    setPalm(null);
    setRatio(null);
    setNormalized(null);
    setOpenness(null);
    setCalibrationError(null);
  }, [
    clearOverlay,
    closeLandmarker,
    stopLoop,
    stopStream,
    updateCameraStatus,
    updateHandStatus,
  ]);

  const start = useCallback(async () => {
    if (
      cameraStatusRef.current === 'requesting' ||
      cameraStatusRef.current === 'loading' ||
      cameraStatusRef.current === 'ready'
    ) {
      return;
    }

    if (!window.isSecureContext) {
      updateCameraStatus('error');
      if (mountedRef.current) {
        setError('摄像头需要 HTTPS 或 localhost 环境才能使用。');
      }
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      updateCameraStatus('error');
      if (mountedRef.current) {
        setError('当前浏览器不支持摄像头访问，请使用新版 Chrome/Edge。');
      }
      return;
    }

    const video = videoRef.current;
    if (!video) {
      updateCameraStatus('error');
      if (mountedRef.current) setError('摄像头预览尚未就绪，请重试。');
      return;
    }

    // 清掉旧会话，保证重复开始也是干净的。
    stopLoop();
    stopStream();
    closeLandmarker();
    latestLandmarksRef.current = null;
    clearOverlay();

    const token = ++startTokenRef.current;
    updateCameraStatus('requesting');
    updateHandStatus('waiting');
    if (mountedRef.current) {
      setError(null);
      setRecognitionError(null);
      setCalibrationError(null);
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
    } catch (cameraError) {
      if (token !== startTokenRef.current) return;
      updateCameraStatus('error');
      if (mountedRef.current) setError(cameraErrorMessage(cameraError));
      return;
    }

    if (token !== startTokenRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    streamRef.current = stream;
    video.srcObject = stream;

    try {
      await video.play();
    } catch {
      stopStream();
      if (token !== startTokenRef.current) return;
      updateCameraStatus('error');
      if (mountedRef.current) {
        setError('无法播放摄像头画面，请检查设备状态。');
      }
      return;
    }

    if (token !== startTokenRef.current) {
      stopStream();
      return;
    }

    updateCameraStatus('loading');

    let landmarker: HandLandmarker;
    try {
      landmarker = await createHandLandmarker();
    } catch {
      stopStream();
      if (token !== startTokenRef.current) return;
      updateCameraStatus('error');
      if (mountedRef.current) {
        setError(
          '手势识别模型加载失败。请确认 public/models/hand_landmarker.task 与 wasm 文件存在。',
        );
      }
      return;
    }

    if (token !== startTokenRef.current) {
      landmarker.close();
      stopStream();
      return;
    }

    landmarkerRef.current = landmarker;
    lastVideoTimeRef.current = -1;
    lastDetectRef.current = 0;
    lastPublishRef.current = 0;
    lastSeenRef.current = 0;
    lastRatioRef.current = null;
    hasValueRef.current = false;
    smoothedRef.current = 0;

    updateCameraStatus('ready');
    updateHandStatus('waiting');
    startLoop();
  }, [
    clearOverlay,
    closeLandmarker,
    startLoop,
    stopLoop,
    stopStream,
    updateCameraStatus,
    updateHandStatus,
  ]);

  const resetSmoothingFor = useCallback((nextCalibration: Calibration | null) => {
    if (lastRatioRef.current === null) {
      hasValueRef.current = false;
      return;
    }
    const mapped = mapRatioToOpenness(lastRatioRef.current, nextCalibration);
    smoothedRef.current = mapped;
    hasValueRef.current = true;
    if (mountedRef.current) {
      setNormalized(mapped);
      setOpenness(mapped);
    }
  }, []);

  const commitCalibration = useCallback(
    (closed: number, open: number) => {
      const next = { closed, open };
      if (!isValidCalibration(next)) {
        calibrationRef.current = null;
        if (mountedRef.current) {
          setCalibration(null);
          setCalibrationError(
            `闭合与张开的参考值过于接近或顺序相反（至少相差 ${MIN_CALIBRATION_GAP.toFixed(2)}），请重新校准。`,
          );
        }
        return;
      }

      calibrationRef.current = next;
      if (mountedRef.current) {
        setCalibration(next);
        setCalibrationError(null);
      }
      resetSmoothingFor(next);
    },
    [resetSmoothingFor],
  );

  const recordClosed = useCallback(() => {
    if (handStatusRef.current !== 'tracking' || lastRatioRef.current === null) {
      if (mountedRef.current) {
        setCalibrationError('请先让手部进入画面并保持跟踪，再记录闭合值。');
      }
      return;
    }

    const closed = lastRatioRef.current;
    closedSampleRef.current = closed;
    if (mountedRef.current) setClosedSample(closed);

    const open = openSampleRef.current;
    if (open === null) {
      calibrationRef.current = null;
      if (mountedRef.current) {
        setCalibration(null);
        setCalibrationError(null);
      }
      return;
    }
    commitCalibration(closed, open);
  }, [commitCalibration]);

  const recordOpen = useCallback(() => {
    if (handStatusRef.current !== 'tracking' || lastRatioRef.current === null) {
      if (mountedRef.current) {
        setCalibrationError('请先让手部进入画面并保持跟踪，再记录张开值。');
      }
      return;
    }

    const open = lastRatioRef.current;
    openSampleRef.current = open;
    if (mountedRef.current) setOpenSample(open);

    const closed = closedSampleRef.current;
    if (closed === null) {
      calibrationRef.current = null;
      if (mountedRef.current) {
        setCalibration(null);
        setCalibrationError(null);
      }
      return;
    }
    commitCalibration(closed, open);
  }, [commitCalibration]);

  const resetCalibration = useCallback(() => {
    calibrationRef.current = null;
    closedSampleRef.current = null;
    openSampleRef.current = null;
    if (mountedRef.current) {
      setCalibration(null);
      setClosedSample(null);
      setOpenSample(null);
      setCalibrationError(null);
    }
    resetSmoothingFor(null);
  }, [resetSmoothingFor]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startTokenRef.current += 1;
      stopLoop();
      stopStream();
      closeLandmarker();
    };
  }, [closeLandmarker, stopLoop, stopStream]);

  return {
    videoRef,
    overlayRef,
    latestLandmarksRef,
    cameraStatus,
    handStatus,
    error,
    recognitionError,
    pinch,
    palm,
    ratio,
    normalized,
    openness,
    calibration,
    closedSample,
    openSample,
    calibrationError,
    isActive:
      cameraStatus === 'requesting' ||
      cameraStatus === 'loading' ||
      cameraStatus === 'ready',
    start,
    stop,
    recordClosed,
    recordOpen,
    resetCalibration,
  };
}
