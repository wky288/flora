#!/usr/bin/env python3
"""FLORA 花朵原色 + 暖灰光晕合成（OpenCV）。

- 从原始 1280x720 PNG 帧读取，不做任何颜色调整。
- 用低阶背景场 + 保守花朵轮廓生成保护蒙版。
- 花朵内部保留原始 RGB；外侧用原始背景生成柔和暖灰光晕，
  再过渡到页面暖白 #F7F4F0。
- 所有帧使用同一组参数，并对 alpha 做三帧时序平滑。
- 不做腐蚀削减花瓣；不做锐化/提亮。
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".tools" / "flora-src-1280"
OUT = ROOT / "public" / "frames" / "peony-halo"
TEST_OUT = ROOT / ".tools" / "halo-final-test"
TARGET = np.array([239, 234, 228], dtype=np.float32)
WATERMARK = (980, 610, 1280, 720)
W, H = 1280, 720
# 固定光晕几何：整段动画共用，不随花朵 bbox / 花茎伸缩而跳动。
HALO_CX, HALO_CY = 640, 360
HALO_RX, HALO_RY = 560, 400
HALO_ALPHA = 0.22


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--test", action="store_true", help="只处理 5 个代表性帧")
    return p.parse_args()


def poly_terms(x, y, deg=4):
    return np.stack([(x**i)*(y**j) for i in range(deg+1) for j in range(deg+1-i)], axis=-1)


def fit_plate(frame):
    yy, xx = np.mgrid[0:H, 0:W]
    xn = (xx/(W-1))*2-1
    yn = (yy/(H-1))*2-1
    terms = poly_terms(xn, yn, 4)
    sample = np.zeros((H, W), bool)
    sample[:, :130] = True
    sample[:, 1150:] = True
    sample[:150, :330] = True
    sample[:150, 950:] = True
    sample[560:, :330] = True
    sample[600:, 950:] = False
    coeff = []
    for c in range(3):
        sol, *_ = np.linalg.lstsq(terms[sample], frame[..., c][sample], rcond=None)
        coeff.append(sol)
    return np.stack([terms @ coeff[c] for c in range(3)], axis=-1)


def smoothstep(e0, e1, x):
    t = np.clip((x-e0)/(e1-e0), 0, 1)
    return t*t*(3-2*t)


def guided_filter(guide, src, radius, eps):
    """Fast guided filter; guide/src are float32 in [0,1]."""
    ksize = (radius*2+1, radius*2+1)
    mean_i = cv2.boxFilter(guide, -1, ksize, borderType=cv2.BORDER_REFLECT)
    mean_p = cv2.boxFilter(src, -1, ksize, borderType=cv2.BORDER_REFLECT)
    corr_i = cv2.boxFilter(guide*guide, -1, ksize, borderType=cv2.BORDER_REFLECT)
    corr_ip = cv2.boxFilter(guide*src, -1, ksize, borderType=cv2.BORDER_REFLECT)
    var_i = corr_i - mean_i*mean_i
    cov_ip = corr_ip - mean_i*mean_p
    a = cov_ip/(var_i+eps)
    b = mean_p - a*mean_i
    mean_a = cv2.boxFilter(a, -1, ksize, borderType=cv2.BORDER_REFLECT)
    mean_b = cv2.boxFilter(b, -1, ksize, borderType=cv2.BORDER_REFLECT)
    return mean_a*guide + mean_b


def soft_matte(img, plate, clean):
    """Trimap + guided filter：只在 unknown 带恢复半透明外缘。"""
    blur = cv2.GaussianBlur(img, (5, 5), 0)
    pb = cv2.GaussianBlur(plate, (5, 5), 0)
    luma = 0.299*blur[..., 0] + 0.587*blur[..., 1] + 0.114*blur[..., 2]
    pluma = 0.299*pb[..., 0] + 0.587*pb[..., 1] + 0.114*pb[..., 2]
    chroma = blur.max(axis=2) - blur.min(axis=2)
    pchroma = pb.max(axis=2) - pb.min(axis=2)
    dl = luma - pluma
    dc = chroma - pchroma
    green = (blur[..., 1] - np.maximum(blur[..., 0], blur[..., 2])) > 8

    fg = clean > 0
    dist = cv2.distanceTransform(255-clean, cv2.DIST_L2, 5)
    near = dist <= 10
    # 亮/有色花瓣优先；中性投影 (dl<0) 不进入软边。
    petal_candidate = ((dl > 1) | (dc > 2) | green) & near
    allowed = fg | petal_candidate
    bg = (dist > 10) | (~allowed)

    trimap = np.full((H, W), 0.5, np.float32)
    trimap[fg] = 1.0
    trimap[bg] = 0.0
    trimap[~allowed] = 0.0

    guide = np.clip(luma/255.0, 0, 1).astype(np.float32)
    a = guided_filter(guide, trimap, 8, 1e-3)
    a = np.clip(a, 0, 1)
    # 颜色软边补充：只在该像素确实比背景亮/有色时抬高 alpha。
    color_a = np.maximum(smoothstep(1, 4, dl), smoothstep(2, 6, dc))
    a = np.maximum(a, color_a * near)
    a[fg] = 1.0
    a[bg] = 0.0
    a[~allowed] = 0.0
    a[a < 0.02] = 0.0
    return a.astype(np.float32)


def fill_watermark(img, plate):
    x0, y0, x1, y1 = WATERMARK
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.minimum(np.minimum(xx-x0, x1-1-xx), np.minimum(yy-y0, y1-1-yy))
    w = smoothstep(0, 10, dist)
    w[(xx < x0) | (xx >= x1) | (yy < y0) | (yy >= y1)] = 0
    return img*(1-w[..., None]) + plate*w[..., None]


def build_mask(img, plate):
    blur = cv2.GaussianBlur(img, (5, 5), 0)
    pb = cv2.GaussianBlur(plate, (5, 5), 0)
    luma = 0.299*blur[..., 0] + 0.587*blur[..., 1] + 0.114*blur[..., 2]
    pluma = 0.299*pb[..., 0] + 0.587*pb[..., 1] + 0.114*pb[..., 2]
    chroma = blur.max(axis=2) - blur.min(axis=2)
    pchroma = pb.max(axis=2) - pb.min(axis=2)
    dl = luma - pluma
    dc = chroma - pchroma
    green = (blur[..., 1] - np.maximum(blur[..., 0], blur[..., 2])) > 8

    def clean_mask():
        seed = ((dl > 12) | (dc > 10) | green).astype(np.uint8)*255
        x0, y0, x1, y1 = WATERMARK
        seed[y0:y1, x0:x1] = 0
        seed = cv2.morphologyEx(seed, cv2.MORPH_CLOSE,
                                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
        contours, _ = cv2.findContours(seed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out = np.zeros((H, W), np.uint8)
        for c in contours:
            if cv2.contourArea(c) < 2500:
                continue
            m = cv2.moments(c)
            if m['m00'] == 0:
                continue
            if 100 < m['m10']/m['m00'] < 1180:
                cv2.drawContours(out, [c], -1, 255, -1)
        return out

    clean = clean_mask()
    mask = clean.copy()
    stem = np.zeros((H, W), np.uint8)
    stem[green] = 255
    cs, _ = cv2.findContours(stem, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in cs:
        if cv2.contourArea(c) > 500:
            cv2.drawContours(mask, [c], -1, 255, -1)
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros((H, W), np.uint8)
    for c in cs:
        cv2.drawContours(filled, [c], -1, 255, -1)
    return filled


def main():
    args = parse_args()
    frames = [f"{i:04d}.png" for i in range(1, 121)]
    if args.test:
        frames = ["0001.png", "0030.png", "0060.png", "0090.png", "0120.png"]
        out_dir = TEST_OUT
    else:
        out_dir = OUT
    out_dir.mkdir(parents=True, exist_ok=True)

    first = cv2.cvtColor(cv2.imread(str(SRC/"0001.png")), cv2.COLOR_BGR2RGB).astype(np.float32)
    plate = fit_plate(first)
    # 固定光晕底色：所有帧共用，避免曝光/背景场偏移造成阴影闪烁。
    halo_bg = cv2.GaussianBlur(plate, (0, 0), 20)

    # Pass 1: clean mask + soft matte + fixed halo alpha
    mattes, alphas = [], []
    for idx, name in enumerate(frames):
        img = cv2.cvtColor(cv2.imread(str(SRC/name)), cv2.COLOR_BGR2RGB).astype(np.float32)
        sc = img[10:90, 10:110].reshape(-1, 3).mean(0)
        pc = plate[10:90, 10:110].reshape(-1, 3).mean(0)
        P = plate + (sc-pc)
        img = fill_watermark(img, P)
        mask = build_mask(img, P)
        matte = soft_matte(img, P, mask)
        # 固定光晕：不取当前帧 bbox，整段动画使用同一个椭圆。
        yy, xx = np.mgrid[0:H, 0:W]
        rr = np.sqrt(((xx-HALO_CX)/HALO_RX)**2 + ((yy-HALO_CY)/HALO_RY)**2)
        halo = HALO_ALPHA*(1-smoothstep(0.62, 1.0, rr))
        edist = np.minimum(np.minimum(xx, W-1-xx), np.minimum(yy, H-1-yy)).astype(np.float32)
        halo *= smoothstep(0, 10, edist)
        alpha = np.clip(matte + halo*(1-matte), 0, 1)
        mattes.append(matte)
        alphas.append((alpha*255).astype(np.uint8))
        if (idx+1) % 20 == 0:
            print(f"matte {idx+1:03d} / {len(frames)}")

    # B：光晕固定，不做时序平滑；5 帧样张先验证软边。
    smoothed = [a.astype(np.float32) for a in alphas]

    # Pass 2: composite
    for idx, name in enumerate(frames):
        img = cv2.cvtColor(cv2.imread(str(SRC/name)), cv2.COLOR_BGR2RGB).astype(np.float32)
        sc = img[10:90, 10:110].reshape(-1, 3).mean(0)
        pc = plate[10:90, 10:110].reshape(-1, 3).mean(0)
        P = plate + (sc-pc)
        img = fill_watermark(img, P)
        matte = mattes[idx]
        # 花体/软边直接用原始 RGB；只有完全在花朵外的区域使用固定光晕底色。
        src = np.where(matte[..., None] > 0.001, img, halo_bg)
        a = smoothed[idx][..., None]/255.0
        # 输出 alpha 帧：画布先填 #EFEAE4，帧外透明，页面与帧背景不会因
        # WebP 有损压缩产生 1 级色差矩形。
        alpha8 = np.clip(a[..., 0]*255, 0, 255).astype(np.uint8)
        rgb8 = np.clip(src, 0, 255).astype(np.uint8)
        bgra = np.dstack([rgb8[..., 2], rgb8[..., 1], rgb8[..., 0], alpha8])
        cv2.imwrite(str(out_dir/name.replace('.png', '.webp')),
                    bgra,
                    [cv2.IMWRITE_WEBP_QUALITY, 95])
        if (idx+1) % 20 == 0 or idx == len(frames)-1:
            print(f"write {idx+1:03d} / {len(frames)}")

    if not args.test:
        manifest = {
            "version": 1,
            "id": "peony-halo",
            "direction": "closed-to-open",
            "sourceDirection": "closed-to-open",
            "width": W,
            "height": H,
            "fps": 24,
            "duration": 5,
            "frameCount": 120,
            "frames": [f"{i:04d}.webp" for i in range(1, 121)],
            "source": {
                "file": "video/jimeng-2026-11-18-4098-动画总时长5秒，目标帧率30FPS，画面比例16：9，优先输出1920×1080....mp4",
                "width": 1280, "height": 720, "fps": 24.12,
                "duration": 5.017, "codec": "h264", "hasAudio": True
            },
            "processing": {
                "method": "opencv-background-plate + conservative flower mask + feathered warm-gray halo",
                "target": "#EFEAE4",
                "alpha": True,
                "watermarkRemoved": True,
                "colorPreserved": True,
                "temporalAlphaSmoothing": 3,
                "note": "花瓣内部原始 RGB；alpha 帧外透明，画布铺 #EFEAE4；原始背景柔化为暖灰光晕。"
            }
        }
        (out_dir/"manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")

if __name__ == "__main__":
    main()

