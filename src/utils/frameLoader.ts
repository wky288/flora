import type {
  FlowerDirection,
  FlowerManifest,
  FrameLoadProgress,
  LoadedFlowerSequence,
} from '../types/flower';

/**
 * 序列帧预加载器。
 *
 * 设计要点：
 * 1. 同一份 manifest 全局只加载一次，模块级缓存保存 Promise 与已解码图片，
 *    React 重新挂载（含 StrictMode）不会重复创建 Image 或重复请求。
 * 2. 所有帧先以 fetch/Image 预加载并 decode，全部完成后才交给播放器，
 *    因此拖动进度条时不会产生新的网络请求，也不会出现白帧。
 * 3. 加载进度通过订阅方式广播，组件卸载只取消订阅，不中断预加载。
 */

const MAX_CONCURRENT_DECODES = 8;

type ProgressListener = (progress: FrameLoadProgress) => void;

interface CacheEntry {
  status: 'loading' | 'ready' | 'error';
  loaded: number;
  total: number;
  error?: Error;
  sequence?: LoadedFlowerSequence;
  listeners: Set<ProgressListener>;
  promise: Promise<LoadedFlowerSequence>;
}

const cache = new Map<string, CacheEntry>();

export interface FlowerLoadHandle {
  /** 预加载完成的 Promise。 */
  promise: Promise<LoadedFlowerSequence>;
  /** 取消进度订阅（不会中止后台预加载）。 */
  unsubscribe: () => void;
}

/**
 * 订阅指定 manifest 的加载进度，并返回预加载 Promise。
 * 若资源已缓存，会立即收到 100% 进度。
 */
export function preloadFlowerSequence(
  manifestUrl: string,
  onProgress?: ProgressListener,
): FlowerLoadHandle {
  const entry = getOrCreateEntry(manifestUrl);

  if (onProgress) {
    entry.listeners.add(onProgress);
    onProgress(toProgress(entry));
  }

  return {
    promise: entry.promise,
    unsubscribe: () => {
      if (onProgress) entry.listeners.delete(onProgress);
    },
  };
}

/** 清除缓存，用于加载失败后的重试。 */
export function clearFlowerSequenceCache(manifestUrl?: string): void {
  if (manifestUrl) {
    cache.delete(manifestUrl);
    return;
  }
  cache.clear();
}

/** 供测试或调试读取已缓存序列。 */
export function getCachedFlowerSequence(
  manifestUrl: string,
): LoadedFlowerSequence | undefined {
  return cache.get(manifestUrl)?.sequence;
}

function getOrCreateEntry(manifestUrl: string): CacheEntry {
  const existing = cache.get(manifestUrl);
  if (existing) return existing;

  const entry: CacheEntry = {
    status: 'loading',
    loaded: 0,
    total: 0,
    listeners: new Set(),
    promise: new Promise<LoadedFlowerSequence>(() => {
      /* 占位，下一行立即替换 */
    }),
  };

  entry.promise = loadSequence(manifestUrl, entry).then(
    (sequence) => {
      entry.status = 'ready';
      entry.sequence = sequence;
      return sequence;
    },
    (error: unknown) => {
      entry.status = 'error';
      entry.error = toError(error);
      throw entry.error;
    },
  );

  cache.set(manifestUrl, entry);
  return entry;
}

async function loadSequence(
  manifestUrl: string,
  entry: CacheEntry,
): Promise<LoadedFlowerSequence> {
  let response: Response;
  try {
    response = await fetch(manifestUrl, { cache: 'no-cache' });
  } catch {
    throw new Error(
      `无法连接帧清单：${manifestUrl}。请确认开发服务器已启动，` +
        '并且对应的 manifest.json 存在。',
    );
  }

  if (!response.ok) {
    throw new Error(
      `帧清单加载失败（HTTP ${response.status}）。请确认 ${manifestUrl} 存在，` +
        '并已执行 npm run frames:extract。',
    );
  }

  let rawManifest: unknown;
  try {
    rawManifest = await response.json();
  } catch {
    throw new Error('帧清单不是合法的 JSON，请重新执行 npm run frames:extract。');
  }

  const manifest = validateManifest(rawManifest);
  const baseUrl = new URL(manifestUrl, window.location.href);

  entry.total = manifest.frames.length;
  emitProgress(entry);

  const images = new Array<HTMLImageElement>(manifest.frames.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= manifest.frames.length) return;

      const frameUrl = new URL(manifest.frames[index], baseUrl).href;
      images[index] = await loadImage(frameUrl, index + 1, manifest.frames.length);
      entry.loaded += 1;
      emitProgress(entry);
    }
  };

  const workerCount = Math.min(MAX_CONCURRENT_DECODES, manifest.frames.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    manifest,
    images,
    manifestUrl: baseUrl.href,
  };
}

function loadImage(src: string, frameNumber: number, total: number): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      // decode() 让浏览器在预加载阶段完成解码；不支持时图片仍可绘制。
      image
        .decode()
        .catch(() => undefined)
        .finally(() => resolve(image));
    };
    image.onerror = () => {
      reject(
        new Error(
          `第 ${frameNumber} / ${total} 帧加载失败：${src}。` +
            '请检查 public/frames/peony 下的图片是否完整。',
        ),
      );
    };
    image.src = src;
  });
}

function emitProgress(entry: CacheEntry): void {
  if (entry.listeners.size === 0) return;
  const progress = toProgress(entry);
  for (const listener of entry.listeners) {
    listener(progress);
  }
}

function toProgress(entry: CacheEntry): FrameLoadProgress {
  const total = entry.total;
  const loaded = Math.min(entry.loaded, total);
  return {
    loaded,
    total,
    percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
  };
}

function validateManifest(raw: unknown): FlowerManifest {
  if (!isRecord(raw)) {
    throw new Error('帧清单格式错误：根节点必须是对象。');
  }

  if (raw.version !== 1) {
    throw new Error(`帧清单版本不受支持：${String(raw.version)}。`);
  }

  const direction = raw.direction;
  if (direction !== 'closed-to-open') {
    throw new Error(
      '帧序列方向必须归一化为 closed-to-open（首帧闭合、末帧盛开）。' +
        '请用 npm run frames:extract -- --source-direction open-to-closed 重新生成。',
    );
  }

  const frameCount = raw.frameCount;
  if (typeof frameCount !== 'number' || !Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error('帧清单缺少有效的 frameCount。');
  }

  const frames = raw.frames;
  if (!Array.isArray(frames) || frames.length !== frameCount) {
    throw new Error('帧清单的 frames 数量与 frameCount 不一致。');
  }

  if (!frames.every((frame): frame is string => typeof frame === 'string' && frame.length > 0)) {
    throw new Error('帧清单的 frames 必须是文件名字符串数组。');
  }

  const width = raw.width;
  const height = raw.height;
  if (!isPositiveNumber(width) || !isPositiveNumber(height)) {
    throw new Error('帧清单缺少有效的画面宽高。');
  }

  if (!isPositiveNumber(raw.fps)) {
    throw new Error('帧清单缺少有效的 fps。');
  }

  const source = raw.source;
  if (!isRecord(source)) {
    throw new Error('帧清单缺少 source 元信息。');
  }

  return {
    version: 1,
    id: typeof raw.id === 'string' ? raw.id : 'flower',
    direction: direction as FlowerDirection,
    sourceDirection:
      raw.sourceDirection === 'open-to-closed'
        ? 'open-to-closed'
        : 'closed-to-open',
    width,
    height,
    fps: raw.fps,
    duration: isPositiveNumber(raw.duration) ? raw.duration : frameCount / raw.fps,
    frameCount,
    frames,
    source: {
      file: typeof source.file === 'string' ? source.file : '(unknown)',
      width: isPositiveNumber(source.width) ? source.width : width,
      height: isPositiveNumber(source.height) ? source.height : height,
      fps: isPositiveNumber(source.fps) ? source.fps : raw.fps,
      duration: isPositiveNumber(source.duration) ? source.duration : 0,
      codec: typeof source.codec === 'string' ? source.codec : 'unknown',
      hasAudio: source.hasAudio === true,
    },
    generatedAt:
      typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date(0).toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
