#!/usr/bin/env node
/**
 * 将原始开花视频转换为 WebP 序列帧，并生成 manifest.json。
 *
 * 用法：
 *   npm run frames:extract
 *   npm run frames:extract -- --input "video/xxx.mp4"
 *   npm run frames:extract -- --fps 24 --width 960 --quality 82
 *   npm run frames:extract -- --source-direction open-to-closed
 *
 * 说明：
 * - 原始视频只读，不会被修改或覆盖。
 * - 只清理输出目录中的 `NNNN.webp` 与 `manifest.json`，不触碰其他文件。
 * - 若源视频为「盛开 → 闭合」，使用 --source-direction open-to-closed，
 *   脚本会反转帧文件顺序，使第 1 帧闭合、最后一帧盛开。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi']);
const DEFAULT_OUT = 'public/frames/peony';
const DEFAULT_FPS = 24;
const DEFAULT_WIDTH = 960;
const DEFAULT_QUALITY = 82;

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const outDir = path.resolve(projectRoot, args.out ?? DEFAULT_OUT);

if (!isInside(projectRoot, outDir)) {
  fail(`输出目录必须位于项目目录内：${outDir}`);
}

const input = resolveInput(args.input);
const ffmpeg = resolveBinary('ffmpeg', 'FFMPEG_PATH');
const ffprobe = resolveBinary('ffprobe', 'FFPROBE_PATH');

console.log(`\n源视频  ${input}\n`);

const source = probeVideo(ffprobe, input);
console.log(`分辨率  ${source.width} × ${source.height}`);
console.log(`时长    ${source.duration.toFixed(3)} s`);
console.log(`帧率    平均 ${source.fps.toFixed(2)} FPS（标称 ${source.rFrameRate}）`);
console.log(`总帧数  ${source.nbFrames ?? '未知'}`);
console.log(`编码    ${source.codec}`);
console.log(`音频    ${source.hasAudio ? `有（${source.audioCodec}）` : '无'}`);
console.log(`方向    ${source.sourceDirection}（人工确认）\n`);

prepareOutput(outDir);

const vf = [
  `fps=${args.fps}`,
  `scale=${args.width}:-2:flags=lanczos`,
].join(',');

console.log(`提取参数  ${vf} · WebP quality=${args.quality}`);
console.log(`输出目录  ${path.relative(projectRoot, outDir)}\n`);

const extract = spawnSync(
  ffmpeg,
  [
    '-hide_banner',
    '-y',
    '-loglevel',
    'warning',
    '-stats',
    '-i',
    input,
    '-an',
    '-vf',
    vf,
    '-c:v',
    'libwebp',
    '-quality',
    String(args.quality),
    '-f',
    'image2',
    path.join(outDir, '%04d.webp'),
  ],
  { stdio: 'inherit' },
);

if (extract.status !== 0) {
  fail(`FFmpeg 提取失败（exit ${extract.status ?? 'unknown'}）。`);
}

let frames = listFrames(outDir);
if (frames.length === 0) {
  fail('没有生成任何帧，请检查 FFmpeg 是否支持 libwebp。');
}

const expected = Math.round(source.duration * args.fps);
if (Math.abs(frames.length - expected) > 1) {
  console.warn(
    `⚠ 生成 ${frames.length} 帧，与「时长 × 帧率」估算的 ${expected} 帧略有差异，已按实际文件为准。`,
  );
}

if (source.sourceDirection === 'open-to-closed') {
  reverseFrames(outDir, frames);
  frames = listFrames(outDir);
  console.log('已反转帧顺序：第 1 帧为闭合状态。');
}

const outHeight = Math.round((source.height * args.width) / source.width / 2) * 2;
const manifest = {
  version: 1,
  id: 'peony',
  direction: 'closed-to-open',
  sourceDirection: source.sourceDirection,
  width: args.width,
  height: outHeight,
  fps: args.fps,
  duration: Number((frames.length / args.fps).toFixed(3)),
  frameCount: frames.length,
  frames,
  source: {
    file: path.basename(input),
    width: source.width,
    height: source.height,
    fps: Number(source.fps.toFixed(3)),
    duration: Number(source.duration.toFixed(3)),
    codec: source.codec,
    hasAudio: source.hasAudio,
  },
  generatedAt: new Date().toISOString(),
};

writeFileSync(
  path.join(outDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

const bytes = frames.reduce(
  (sum, file) => sum + readFileSync(path.join(outDir, file)).byteLength,
  0,
);

console.log('\n完成');
console.log(`  帧数      ${frames.length}`);
console.log(`  尺寸      ${args.width} × ${outHeight}`);
console.log(`  总大小    ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  首帧      ${frames[0]}`);
console.log(`  末帧      ${frames[frames.length - 1]}`);
console.log(`  清单      ${path.relative(projectRoot, path.join(outDir, 'manifest.json'))}\n`);

/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const defaults = {
    input: undefined,
    out: DEFAULT_OUT,
    fps: DEFAULT_FPS,
    width: DEFAULT_WIDTH,
    quality: DEFAULT_QUALITY,
    sourceDirection: 'closed-to-open',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    const readValue = () => {
      if (value === undefined || value.startsWith('--')) {
        fail(`参数 ${flag} 缺少取值。`);
      }
      index += 1;
      return value;
    };

    switch (flag) {
      case '--input':
        defaults.input = readValue();
        break;
      case '--out':
        defaults.out = readValue();
        break;
      case '--fps':
        defaults.fps = parseNumber(readValue(), flag, 1, 120);
        break;
      case '--width':
        defaults.width = parseNumber(readValue(), flag, 64, 3840);
        break;
      case '--quality':
        defaults.quality = parseNumber(readValue(), flag, 1, 100);
        break;
      case '--source-direction': {
        const direction = readValue();
        if (direction !== 'closed-to-open' && direction !== 'open-to-closed') {
          fail('--source-direction 只接受 closed-to-open 或 open-to-closed。');
        }
        defaults.sourceDirection = direction;
        break;
      }
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`未知参数：${flag}`);
    }
  }

  return defaults;
}

function printHelp() {
  console.log(`
FLORA 序列帧提取

  npm run frames:extract [选项]

选项
  --input <path>                源视频路径，默认自动使用 video/ 下唯一的视频
  --out <dir>                   输出目录，默认 public/frames/peony
  --fps <number>                输出帧率，默认 ${DEFAULT_FPS}
  --width <number>              最大宽度，默认 ${DEFAULT_WIDTH}
  --quality <1-100>             WebP 质量，默认 ${DEFAULT_QUALITY}
  --source-direction <value>    closed-to-open（默认）或 open-to-closed
  -h, --help                    显示帮助

环境变量
  FFMPEG_PATH / FFPROBE_PATH    自定义可执行文件路径
`);
}

function resolveInput(input) {
  if (input) {
    const resolved = path.resolve(projectRoot, input);
    if (!existsSync(resolved)) fail(`找不到视频：${resolved}`);
    return resolved;
  }

  const videoDir = path.join(projectRoot, 'video');
  if (!existsSync(videoDir)) {
    fail('找不到 video/ 目录，请将原始开花视频放入其中，或使用 --input 指定。');
  }

  const videos = readdirSync(videoDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(videoDir, entry.name));

  if (videos.length === 0) {
    fail('video/ 目录中没有视频文件，请放入原始视频或使用 --input 指定。');
  }
  if (videos.length > 1) {
    fail(`video/ 目录中有多个视频，请用 --input 指定其中一个：\n${videos.join('\n')}`);
  }
  return videos[0];
}

function resolveBinary(name, envKey) {
  if (process.env[envKey]) {
    if (!existsSync(process.env[envKey])) fail(`${envKey} 指向的文件不存在。`);
    return process.env[envKey];
  }

  const platformKey = `${process.platform}-${process.arch}`;
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    path.join(projectRoot, '.tools', 'ffmpeg', 'node_modules', `@${name}-installer`, platformKey, executable),
    path.join(projectRoot, '.tools', 'bin', executable),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }

  fail(
    `找不到 ${name}。请安装 FFmpeg，或执行：\n` +
      `  npm install --prefix .tools/ffmpeg @${name}-installer/${platformKey} --cache .npm-cache\n` +
      `也可以通过环境变量 ${envKey} 指定路径。`,
  );
}

function probeVideo(ffprobePath, inputPath) {
  // 在受限环境下，子进程的 pipe 可能不可用；改为写入临时文件，避免捕获 stdout。
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'flora-probe-'));
  const stdoutPath = path.join(tempDir, 'probe.json');
  const stderrPath = path.join(tempDir, 'probe.err');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');

  let result;
  try {
    result = spawnSync(
      ffprobePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath],
      { stdio: ['ignore', stdoutFd, stderrFd] },
    );
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  const stderr = readFileSync(stderrPath, 'utf8');
  const stdout = readFileSync(stdoutPath, 'utf8');
  rmSync(tempDir, { recursive: true, force: true });

  if (result.error) {
    fail(`FFprobe 无法启动：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`FFprobe 读取失败：${stderr.trim() || `exit ${result.status}`}`);
  }

  const info = JSON.parse(stdout);
  const video = info.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) fail('该文件不包含视频流。');

  const audio = info.streams?.find((stream) => stream.codec_type === 'audio');
  const fps = parseFraction(video.avg_frame_rate) || parseFraction(video.r_frame_rate) || 0;
  const duration = Number(video.duration ?? info.format?.duration ?? 0);

  if (!fps || !duration) {
    fail('无法从视频中读取帧率或时长。');
  }

  return {
    width: Number(video.width),
    height: Number(video.height),
    duration,
    fps,
    rFrameRate: video.r_frame_rate ?? 'unknown',
    nbFrames: video.nb_frames,
    codec: video.codec_name ?? 'unknown',
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? 'unknown',
    sourceDirection: args.sourceDirection,
  };
}

function parseFraction(value) {
  if (typeof value !== 'string' || !value.includes('/')) return Number(value) || 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!denominator) return 0;
  return numerator / denominator;
}

function prepareOutput(directory) {
  mkdirSync(directory, { recursive: true });

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/^\d{4}\.webp$/.test(entry.name) || entry.name === 'manifest.json') {
      rmSync(path.join(directory, entry.name), { force: true });
    }
  }
}

function listFrames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}\.webp$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function reverseFrames(directory, frames) {
  const temporary = frames.map((_, index) =>
    path.join(directory, `__reverse_${String(index + 1).padStart(4, '0')}.webp`),
  );

  frames.forEach((file, index) => {
    renameSync(path.join(directory, file), temporary[index]);
  });

  temporary
    .slice()
    .reverse()
    .forEach((tempFile, index) => {
      renameSync(tempFile, path.join(directory, frames[index]));
    });
}

function parseNumber(value, flag, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    fail(`${flag} 需要 ${min}–${max} 之间的数值，收到：${value}`);
  }
  return parsed;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function fail(message) {
  console.error(`\n错误：${message}\n`);
  process.exit(1);
}
