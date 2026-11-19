#!/usr/bin/env python3
"""生成阶段 4 展示序列帧：保留原始花色、奶油背景、去除水印。

处理思路：
1. 先用低阶多项式拟合摄影棚背景，生成一张柔和的背景场；
2. 对原始帧做轻度背景融合，得到一张“完整花朵 + 平面奶油背景”的引导图；
3. 从引导图中提取完整花朵轮廓（轮廓只用于 alpha，不改变花色）；
4. 用原始像素恢复花朵内部颜色，仅在边缘用引导图过渡；
5. 用背景色覆盖右下角水印区域（该区域为纯背景，不涉及花瓣）；
6. 输出 public/frames/peony-display，原始帧不修改。

依赖：Pillow、numpy。
用法：
  python scripts/grade_frames.py
  python scripts/grade_frames.py --target EFEAE4 --saturation 1.4
"""

from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "public" / "frames" / "peony"
OUTPUT_DIR = ROOT / "public" / "frames" / "peony-display"
DEFAULT_TARGET = "EFEAE4"

# 水印完全位于右下角背景区域，花瓣边缘在其上方。
# 该 bbox 只用于把水印覆盖掉，不参与花朵裁切。
WATERMARK_BOX = (725, 468, 960, 540)  # x0, y0, x1, y1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=DEFAULT_TARGET, help="目标背景色，十六进制")
    parser.add_argument("--saturation", type=float, default=1.4, help="仅用于轮廓引导图的饱和度")
    parser.add_argument("--detail", type=float, default=0.95, help="仅用于轮廓引导图的细节强度")
    parser.add_argument("--quality", type=int, default=92, help="WebP 质量")
    return parser.parse_args()


def hex_to_rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    if len(value) != 6:
        raise ValueError("目标色必须是 6 位十六进制。")
    return np.array([int(value[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)


def poly_terms(x: np.ndarray, y: np.ndarray, degree: int) -> np.ndarray:
    return np.stack(
        [(x**i) * (y**j) for i in range(degree + 1) for j in range(degree + 1 - i)],
        axis=-1,
    )


def smoothstep(edge0: float, edge1: float, values: np.ndarray) -> np.ndarray:
    t = np.clip((values - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def fit_plate(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """从闭合帧的背景区域拟合平滑的摄影棚背景。"""
    height, width = frame.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width]
    xn = (xx / (width - 1)) * 2.0 - 1.0
    yn = (yy / (height - 1)) * 2.0 - 1.0
    terms = poly_terms(xn, yn, 4)

    sample = np.ones((height, width), dtype=bool)
    sample[:, 250:720] = False
    sample[0:110, 250:720] = True
    sample[430:540, 830:960] = False

    coefficients = []
    for channel in range(3):
        solution, *_ = np.linalg.lstsq(
            terms[sample], frame[..., channel][sample], rcond=None
        )
        coefficients.append(solution)

    plate = np.stack(
        [terms @ coefficients[channel] for channel in range(3)], axis=-1
    )
    return plate, terms


def keep_largest_component(binary: np.ndarray) -> np.ndarray:
    """保留最大连通区域，去掉背景噪点。"""
    height, width = binary.shape
    seen = np.zeros_like(binary, dtype=bool)
    best: list[tuple[int, int]] = []

    for start_y in range(0, height, 3):
        for start_x in range(0, width, 3):
            if not binary[start_y, start_x] or seen[start_y, start_x]:
                continue
            queue = deque([(start_y, start_x)])
            seen[start_y, start_x] = True
            component: list[tuple[int, int]] = []

            while queue:
                y, x = queue.popleft()
                component.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if (
                        0 <= ny < height
                        and 0 <= nx < width
                        and binary[ny, nx]
                        and not seen[ny, nx]
                    ):
                        seen[ny, nx] = True
                        queue.append((ny, nx))

            if len(component) > len(best):
                best = component

    result = np.zeros_like(binary)
    if best:
        ys = np.array([point[0] for point in best])
        xs = np.array([point[1] for point in best])
        result[ys, xs] = True
    return result


def fill_holes(binary: np.ndarray) -> np.ndarray:
    """填充被前景包围的孔洞；与画布边界连通的区域保持透明。"""
    height, width = binary.shape
    outside = np.zeros_like(binary, dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        for y in (0, height - 1):
            if not binary[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((y, x))
    for y in range(height):
        for x in (0, width - 1):
            if not binary[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((y, x))

    while queue:
        y, x = queue.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if (
                0 <= ny < height
                and 0 <= nx < width
                and not binary[ny, nx]
                and not outside[ny, nx]
            ):
                outside[ny, nx] = True
                queue.append((ny, nx))

    return binary | ((~binary) & (~outside))


def morph(binary: np.ndarray, filt: ImageFilter, size: int) -> np.ndarray:
    image = Image.fromarray((binary * 255).astype(np.uint8))
    return np.asarray(image.filter(filt(size))) > 128


def grade_guide(
    frame: np.ndarray,
    plate: np.ndarray,
    target: np.ndarray,
    saturation: float,
    detail_strength: float,
) -> np.ndarray:
    """生成用于提取轮廓的引导图。颜色会被提亮，只用于 alpha 计算。"""
    height, width = frame.shape[:2]
    source_corner = frame[10:70, 10:90].reshape(-1, 3).mean(axis=0)
    plate_corner = plate[10:70, 10:90].reshape(-1, 3).mean(axis=0)
    local_plate = plate + (source_corner - plate_corner)

    diff = np.sqrt(((frame - local_plate) ** 2).sum(axis=2))

    blurred = np.asarray(
        Image.fromarray(frame.astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    ).astype(np.float64)
    detail = frame - blurred

    base = frame + (target - local_plate) + detail_strength * detail
    luminance = (
        0.299 * base[..., 0] + 0.587 * base[..., 1] + 0.114 * base[..., 2]
    )[..., None]
    base = luminance + saturation * (base - luminance)
    base = (base - target) * 1.04 + target

    mask = smoothstep(10.0, 25.0, diff)
    mask_image = Image.fromarray((mask * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(1.0)
    )
    mask = np.asarray(mask_image).astype(np.float64) / 255.0

    guide = target * (1.0 - mask[..., None]) + base * mask[..., None]
    return np.clip(guide, 0, 255)


def build_alpha(
    guide: np.ndarray,
    target: np.ndarray,
    frame: np.ndarray,
    local_plate: np.ndarray,
) -> np.ndarray:
    """从引导图提取完整花朵 alpha，并剔除水印区域。"""
    height, width = guide.shape[:2]
    difference = np.abs(guide - target).max(axis=2)

    seed = difference > 4.0
    x0, y0, x1, y1 = watermark_box(width, height)
    seed[y0:y1, x0:x1] = False

    seed = morph(seed, ImageFilter.MinFilter, 3)
    seed = morph(seed, ImageFilter.MaxFilter, 7)

    binary = keep_largest_component(seed)
    binary = fill_holes(binary)

    # 深色、低饱和的区域是投影而不是花瓣；从轮廓中剔除，避免奶油底上出现灰边。
    luma = 0.299 * frame[..., 0] + 0.587 * frame[..., 1] + 0.114 * frame[..., 2]
    plate_luma = (
        0.299 * local_plate[..., 0]
        + 0.587 * local_plate[..., 1]
        + 0.114 * local_plate[..., 2]
    )
    chroma = frame.max(axis=2) - frame.min(axis=2)
    plate_chroma = local_plate.max(axis=2) - local_plate.min(axis=2)
    shadow = (luma - plate_luma < -5.0) & (chroma - plate_chroma < 7.0)
    binary = binary & ~shadow
    binary = fill_holes(binary)

    # 向内收缩 1–2px，去掉背景/阴影形成的灰色边缘。
    binary = morph(binary, ImageFilter.MinFilter, 5)
    binary = fill_holes(binary)

    # 茎是细长的绿色结构，单独补回，避免被最大连通区域漏掉。
    green = guide[..., 1] - np.maximum(guide[..., 0], guide[..., 2])
    stem = morph(green > 2.0, ImageFilter.MaxFilter, 3)
    binary = binary | stem
    binary = fill_holes(binary)

    alpha = np.asarray(
        Image.fromarray((binary * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(0.7)
        )
    ).astype(np.float64) / 255.0
    alpha = np.clip((alpha - 0.12) / 0.76, 0.0, 1.0)

    alpha[y0:y1, x0:x1] = 0.0
    return alpha


def watermark_box(width: int, height: int) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = WATERMARK_BOX
    return (min(x0, width), min(y0, height), min(x1, width), min(y1, height))


def main() -> None:
    args = parse_args()
    target = hex_to_rgb(args.target)

    manifest_path = SOURCE_DIR / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"找不到源清单：{manifest_path}")

    source_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    frame_files = source_manifest["frames"]

    first_frame = np.asarray(
        Image.open(SOURCE_DIR / frame_files[0]).convert("RGB")
    ).astype(np.float64)
    plate, _ = fit_plate(first_frame)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT_DIR.iterdir():
        if stale.is_file() and (stale.suffix == ".webp" or stale.name == "manifest.json"):
            stale.unlink()

    for index, name in enumerate(frame_files, start=1):
        frame = np.asarray(
            Image.open(SOURCE_DIR / name).convert("RGB")
        ).astype(np.float64)

        source_corner = frame[10:70, 10:90].reshape(-1, 3).mean(axis=0)
        plate_corner = plate[10:70, 10:90].reshape(-1, 3).mean(axis=0)
        local_plate = plate + (source_corner - plate_corner)

        guide = grade_guide(
            frame, plate, target, args.saturation, args.detail
        )
        x0, y0, x1, y1 = watermark_box(frame.shape[1], frame.shape[0])
        guide[y0:y1, x0:x1] = target  # 覆盖右上角水印

        alpha = build_alpha(guide, target, frame, local_plate)
        a = alpha[..., None]

        # 用原始像素恢复花瓣颜色；在 alpha 边缘用引导图过渡，避免灰色描边。
        foreground = (frame - (1.0 - a) * local_plate) / np.maximum(a, 0.2)
        foreground = np.clip(foreground, 0, 255)
        original = foreground * a + target * (1.0 - a)

        edge_softness = smoothstep(0.82, 0.98, alpha)
        output = guide * (1.0 - edge_softness[..., None]) + original * edge_softness[..., None]
        output = np.clip(output, 0, 255)

        Image.fromarray(output.astype(np.uint8)).save(
            OUTPUT_DIR / name,
            format="WEBP",
            quality=args.quality,
            method=6,
        )
        if index % 20 == 0 or index == len(frame_files):
            print(f"  {index:03d} / {len(frame_files)}")

    manifest = {
        **source_manifest,
        "id": "peony-display",
        "frames": frame_files,
        "grade": {
            "target": f"#{args.target.upper()}",
            "saturation": args.saturation,
            "detail": args.detail,
            "preserveOriginalFlower": True,
            "watermarkRemoved": True,
            "watermarkBox": list(WATERMARK_BOX),
            "note": "轮廓来自引导图，花瓣内部使用原始像素；水印区域仅覆盖背景。",
        },
        "generatedAt": source_manifest.get("generatedAt"),
    }
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    total_bytes = sum(
        (OUTPUT_DIR / name).stat().st_size for name in frame_files
    )
    print(
        f"\n完成：{len(frame_files)} 帧，{total_bytes / 1024 / 1024:.2f} MB，"
        f"背景 #{args.target.upper()}，水印已覆盖，花朵使用原始颜色"
    )


if __name__ == "__main__":
    main()
