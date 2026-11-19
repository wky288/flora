/** 数值工具函数。 */

/** 将数值限制在 [min, max] 区间内。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 将数值限制在 [0, 1] 区间内。 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
