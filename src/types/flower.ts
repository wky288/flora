/** 花朵序列帧相关的共享类型定义。 */

/**
 * 帧序列的开放方向。
 * - `closed-to-open`：第 1 帧闭合，最后一帧盛开（本播放器的标准顺序）
 * - `open-to-closed`：第 1 帧盛开，最后一帧闭合
 */
export type FlowerDirection = 'closed-to-open' | 'open-to-closed';

/** 原始视频的元信息，仅用于追溯与排障。 */
export interface FlowerSourceInfo {
  /** 原始视频文件名（不包含目录）。 */
  file: string;
  width: number;
  height: number;
  /** 视频平均帧率。 */
  fps: number;
  /** 视频时长（秒）。 */
  duration: number;
  codec: string;
  hasAudio: boolean;
}

/**
 * `manifest.json` 的结构。
 *
 * 约定：`frames` 始终按「闭合 → 盛开」排序，播放器无需再关心源视频方向。
 * 如果源视频方向相反，`extract-frames.mjs` 会在生成阶段反转帧文件顺序，
 * 并把原始方向记录到 `sourceDirection` 中。
 */
export interface FlowerManifest {
  version: 1;
  id: string;
  /** 生成后帧序列的方向，固定为 `closed-to-open`。 */
  direction: FlowerDirection;
  /** 原始视频的方向，用于追溯。 */
  sourceDirection: FlowerDirection;
  width: number;
  height: number;
  fps: number;
  /** 序列帧覆盖的时长（秒）。 */
  duration: number;
  frameCount: number;
  /** 相对于 manifest.json 的文件名列表，例如 "0001.webp"。 */
  frames: string[];
  source: FlowerSourceInfo;
  generatedAt: string;
}

/** 预加载完成后的帧序列。 */
export interface LoadedFlowerSequence {
  manifest: FlowerManifest;
  /** 与 manifest.frames 一一对应的已解码图片。 */
  images: HTMLImageElement[];
  /** manifest.json 的绝对 URL，用于解析相对帧路径。 */
  manifestUrl: string;
}

/** 资源加载进度，供界面显示。 */
export interface FrameLoadProgress {
  loaded: number;
  total: number;
  /** 0–100 的整数百分比。 */
  percent: number;
}
