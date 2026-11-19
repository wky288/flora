export type MotionPreset = 'soft' | 'natural' | 'responsive';

export interface MotionConfig {
  /** 指数平滑时间常数（秒）。 */
  smoothingTau: number;
  /** 最大开合速度（0–1 / 秒）。 */
  maxOpennessSpeed: number;
  /** 接近目标时直接吸附的阈值。 */
  settleThreshold: number;
  /** 单帧最大 deltaTime，避免切回标签页时跳变。 */
  maxDeltaTime: number;
  /** 静止手势死区。 */
  deadBand: number;
}

export const MOTION_PRESETS: Record<MotionPreset, MotionConfig> = {
  soft: {
    smoothingTau: 0.24,
    maxOpennessSpeed: 0.55,
    settleThreshold: 0.002,
    maxDeltaTime: 0.05,
    deadBand: 0.002,
  },
  natural: {
    smoothingTau: 0.18,
    maxOpennessSpeed: 0.68,
    settleThreshold: 0.002,
    maxDeltaTime: 0.05,
    deadBand: 0.002,
  },
  responsive: {
    smoothingTau: 0.12,
    maxOpennessSpeed: 0.85,
    settleThreshold: 0.002,
    maxDeltaTime: 0.05,
    deadBand: 0.002,
  },
};

export const DEFAULT_MOTION_PRESET: MotionPreset = 'natural';

export const MOTION_PRESET_LABELS: Record<MotionPreset, string> = {
  soft: '柔和',
  natural: '自然',
  responsive: '灵敏',
};
