import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export interface Calibration {
  closed: number;
  open: number;
}

export interface HandMetrics {
  pinch: number;
  palm: number;
  ratio: number;
  valid: boolean;
}

export const DEFAULT_CALIBRATION: Calibration = {
  closed: 0.12,
  open: 1.25,
};

export const MIN_CALIBRATION_GAP = 0.12;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 用缩略图坐标计算捏合距离与手掌参考距离。
 *
 * x 坐标乘以视频宽高比，避免 16:9 画面把横向距离压扁。
 * 这里的坐标来自原始视频，不受预览镜像影响。
 */
export function getHandMetrics(
  landmarks: NormalizedLandmark[],
  aspectRatio: number,
): HandMetrics {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];

  if (!thumbTip || !indexTip || !wrist || !middleMcp) {
    return { pinch: 0, palm: 0, ratio: 0, valid: false };
  }

  const aspect = aspectRatio > 0 ? aspectRatio : 1;

  const pinch = Math.hypot(
    (thumbTip.x - indexTip.x) * aspect,
    thumbTip.y - indexTip.y,
  );
  const palm = Math.hypot(
    (wrist.x - middleMcp.x) * aspect,
    wrist.y - middleMcp.y,
  );

  if (!Number.isFinite(pinch) || !Number.isFinite(palm) || palm < 0.015) {
    return { pinch, palm, ratio: 0, valid: false };
  }

  return {
    pinch,
    palm,
    ratio: pinch / palm,
    valid: true,
  };
}

export function isValidCalibration(
  calibration: Calibration | null,
): calibration is Calibration {
  if (!calibration) return false;
  const { closed, open } = calibration;
  return (
    Number.isFinite(closed) &&
    Number.isFinite(open) &&
    open > closed &&
    open - closed >= MIN_CALIBRATION_GAP
  );
}

/**
 * 两点校准映射：闭合参考值 -> 0，张开参考值 -> 1。
 * 未校准或参考值异常时退回临时范围，仍保持连续输出。
 */
export function mapRatioToOpenness(
  ratio: number,
  calibration: Calibration | null,
): number {
  const range = isValidCalibration(calibration)
    ? calibration
    : DEFAULT_CALIBRATION;
  return clamp01((ratio - range.closed) / (range.open - range.closed));
}

/** 指数平滑；调用方负责死区与 0/1 吸附。 */
export function smoothValue(
  previous: number,
  target: number,
  alpha: number,
): number {
  return previous + (target - previous) * alpha;
}
