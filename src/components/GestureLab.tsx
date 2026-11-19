import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  MOTION_PRESET_LABELS,
  type MotionPreset,
} from '../config/motion';
import { useCameraPip } from '../hooks/useCameraPip';
import type {
  CameraStatus,
  HandGestureController,
  HandStatus,
} from '../hooks/useHandGesture';

const DEFAULT_CAMERA_WIDTH = 440;
const MIN_CAMERA_WIDTH = 320;
const MAX_CAMERA_WIDTH = 720;
const MAX_VIEWPORT_RATIO = 0.6;

const cameraLabels: Record<CameraStatus, string> = {
  idle: 'OFF / 未开启',
  requesting: 'REQUESTING / 请求权限',
  loading: 'LOADING / 加载模型',
  ready: 'LIVE / 摄像头已开启',
  error: 'ERROR / 摄像头不可用',
};

const handLabels: Record<HandStatus, string> = {
  waiting: 'WAITING / 等待手部',
  tracking: 'TRACKING / 已识别',
  lost: 'HOLD / 手部暂时离开',
};

function format(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

export function GestureLab({
  gesture,
  open,
  onClose,
  showMotionPreset,
  motionPreset,
  onMotionPresetChange,
}: {
  gesture: HandGestureController;
  open: boolean;
  onClose: () => void;
  showMotionPreset: boolean;
  motionPreset: MotionPreset;
  onMotionPresetChange: (preset: MotionPreset) => void;
}) {
  const {
    videoRef,
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
    isActive,
    start,
    stop,
    recordClosed,
    recordOpen,
    resetCalibration,
  } = gesture;

  const canCalibrate = handStatus === 'tracking' && ratio !== null;
  const percent =
    openness === null
      ? '--'
      : String(Math.round(openness * 100)).padStart(2, '0');
  const progress = openness === null ? 0 : openness * 100;
  const pip = useCameraPip(videoRef, latestLandmarksRef, isActive, open);

  const [cameraWidth, setCameraWidth] = useState(DEFAULT_CAMERA_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_CAMERA_WIDTH);

  const clampCameraWidth = (value: number) => {
    const max = Math.min(
      MAX_CAMERA_WIDTH,
      window.innerWidth * MAX_VIEWPORT_RATIO,
    );
    return Math.max(
      MIN_CAMERA_WIDTH,
      Math.min(max, Math.round(value)),
    );
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (window.innerWidth <= 720) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizingRef.current = true;
    setIsResizing(true);
    resizeStartXRef.current = event.clientX;
    resizeStartWidthRef.current = cameraWidth;
  };

  const handleResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!resizingRef.current) return;
    const delta = resizeStartXRef.current - event.clientX;
    setCameraWidth(
      clampCameraWidth(resizeStartWidthRef.current + delta),
    );
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const handleCamera = () => {
    if (isActive) {
      void pip.exit();
      stop();
    } else {
      void start();
    }
  };

  return (
    <>
      <button
        className={`camera-backdrop ${open ? 'is-open' : ''}`}
        type="button"
        aria-hidden={!open}
        tabIndex={-1}
        aria-label="关闭摄像头界面"
        onClick={onClose}
      />

      <aside
        id="camera-drawer"
        className={`camera-drawer ${open ? 'is-open' : ''} ${isResizing ? 'is-resizing' : ''}`}
        style={
          {
            '--camera-width': `${cameraWidth}px`,
          } as CSSProperties
        }
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        aria-labelledby="camera-drawer-title"
      >
        <div
          className="camera-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整摄像头窗口宽度"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />

        <header className="camera-drawer-head">
          <div>
            <p className="camera-drawer-kicker">05 / CAMERA INPUT</p>
            <h2 className="camera-drawer-title" id="camera-drawer-title">
              手势控制
            </h2>
          </div>
          <button
            className="camera-drawer-close"
            type="button"
            onClick={onClose}
            aria-label="关闭摄像头界面"
          >
            关闭
          </button>
        </header>

        <div className="gesture-lab-body">
          <div className="gesture-preview">
            <div className={`camera-stage ${cameraStatus === 'ready' ? 'is-ready' : ''}`}>
              <div className="camera-preview">
                <video
                  ref={videoRef}
                  className="camera-source-video"
                  autoPlay
                  muted
                  playsInline
                  aria-hidden="true"
                />
                <video
                  ref={pip.videoRef}
                  className="camera-video"
                  autoPlay
                  muted
                  playsInline
                  aria-label="合成后的摄像头预览"
                />
              </div>

              {!isActive && (
                <div className="camera-placeholder">
                  <span className="camera-placeholder-mark" aria-hidden="true" />
                  <p>摄像头未开启</p>
                  <span>点击下方按钮后才会申请权限</span>
                </div>
              )}

              {isActive && cameraStatus !== 'ready' && (
                <div className="camera-pending" role="status">
                  {cameraStatus === 'requesting'
                    ? '正在请求摄像头权限…'
                    : '正在加载手势识别模型…'}
                </div>
              )}
            </div>

            <div className="camera-actions">
              <button
                className="gesture-button is-primary"
                type="button"
                onClick={handleCamera}
              >
                {isActive
                  ? '关闭摄像头'
                  : cameraStatus === 'error'
                    ? '重试摄像头'
                    : '开启摄像头'}
              </button>
              <button
                className="gesture-button"
                type="button"
                disabled={!isActive || cameraStatus !== 'ready' || !pip.supported}
                aria-pressed={pip.active}
                title={
                  pip.supported
                    ? '在带节点的独立窗口中打开摄像头'
                    : '当前浏览器不支持画中画'
                }
                onClick={pip.toggle}
              >
                {pip.active ? '退出画中画' : '画中画'}
              </button>
              <span className="camera-state" aria-live="polite">
                {cameraLabels[cameraStatus]}
              </span>
            </div>

            {(error || recognitionError) && (
              <p className="gesture-error" role="alert">
                {error ?? recognitionError}
              </p>
            )}
            {pip.error && (
              <p className="gesture-error" role="alert">
                {pip.error}
              </p>
            )}
          </div>

          <div className="gesture-readout">
            <div className="openness-head">
              <div>
                <p className="gesture-label">OPENNESS</p>
                <p
                  className={`openness-value ${openness === null ? 'is-empty' : ''}`}
                  aria-live="polite"
                >
                  {percent}
                  {openness !== null && <small>%</small>}
                </p>
              </div>
              <span className="openness-caption">
                {calibration === null ? '临时范围 · 建议校准' : '手势控制 · 实时开合'}
              </span>
            </div>

            <div className="openness-track" aria-hidden="true">
              <i style={{ width: `${progress}%` }} />
            </div>

            <div className="gesture-metrics">
              <div className="gesture-metric">
                <span>PINCH DISTANCE</span>
                <strong>{format(pinch)}</strong>
              </div>
              <div className="gesture-metric">
                <span>PALM REFERENCE</span>
                <strong>{format(palm)}</strong>
              </div>
              <div className="gesture-metric">
                <span>PINCH / PALM</span>
                <strong>{format(ratio)}</strong>
              </div>
              <div className="gesture-metric">
                <span>NORMALIZED</span>
                <strong>{format(normalized, 2)}</strong>
              </div>
              <div className="gesture-metric">
                <span>CAMERA</span>
                <strong>{cameraLabels[cameraStatus].split(' / ')[0]}</strong>
              </div>
              <div className="gesture-metric">
                <span>HAND</span>
                <strong>{handLabels[handStatus].split(' / ')[0]}</strong>
              </div>
            </div>

            <div className="gesture-calibration">
              <div className="calibration-head">
                <p className="gesture-label">CALIBRATION / 两点校准</p>
                <span
                  className={
                    calibration ? 'calibration-state is-done' : 'calibration-state'
                  }
                >
                  {calibration ? '已校准' : '未校准'}
                </span>
              </div>
              <p className="calibration-copy">
                先捏合拇指与食指，记录闭合；再舒适分开，记录张开。
              </p>

              <div className="calibration-actions">
                <button
                  className="gesture-button"
                  type="button"
                  disabled={!canCalibrate}
                  onClick={recordClosed}
                >
                  记录闭合
                </button>
                <button
                  className="gesture-button"
                  type="button"
                  disabled={!canCalibrate}
                  onClick={recordOpen}
                >
                  记录张开
                </button>
                <button
                  className="gesture-button is-quiet"
                  type="button"
                  onClick={resetCalibration}
                >
                  重置
                </button>
              </div>

              <div className="calibration-values">
                <span>
                  CLOSED <strong>{format(closedSample)}</strong>
                </span>
                <span>
                  OPEN <strong>{format(openSample)}</strong>
                </span>
              </div>

              {calibrationError && (
                <p className="calibration-error" role="alert">
                  {calibrationError}
                </p>
              )}
            </div>

            {showMotionPreset && (
              <div className="motion-preset camera-motion-preset" role="group" aria-label="开合速度预设">
                <span className="motion-preset-label">MOTION SPEED</span>
                <div className="motion-preset-options">
                  {(['soft', 'natural', 'responsive'] as MotionPreset[]).map(
                    (preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={motionPreset === preset ? 'is-active' : ''}
                        aria-pressed={motionPreset === preset}
                        onClick={() => onMotionPresetChange(preset)}
                      >
                        {MOTION_PRESET_LABELS[preset]}
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
