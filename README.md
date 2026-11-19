# FLORA · 指尖花开

## 1. 项目简介

FLORA 是一个以牡丹为唯一视觉主体的实时手势交互页面。

- 页面使用 120 张透明 WebP 序列帧，通过 Canvas 2D 播放花朵开合。
- MediaPipe Hand Landmarker 从摄像头识别拇指/食指捏合程度，映射为 `0–1` 的 openness。
- 手势驱动花朵连续开合，不使用一次性动画事件。
- 摄像头以右侧窗口呈现，拖动左边缘可调整宽度。
- 页面预览和浏览器原生 PiP 都播放“视频帧 + 手部节点”的合成视频，因此节点不会和视频分离。
- 页面为三栏编辑布局：左标题、中花朵、右花名/花语。
- 没有 Manual Mode 或手动滑块；手势是唯一控制方式。

## 2. 技术栈

- React 19 + TypeScript 5.9
- Vite 8
- Canvas 2D 序列帧播放器
- `@mediapipe/tasks-vision` 1.2.3
- `HandLandmarker`（VIDEO 模式，`numHands: 1`）
- WebP 序列帧，透明背景，页面底色 `#EFEAE4`
- 原生 Picture-in-Picture + `canvas.captureStream()`

## 3. 环境要求

- Node.js **>= 20.19**
- npm
- 桌面 Chrome 或 Edge（推荐最新版）
- 摄像头；`localhost` 或 HTTPS 才能调用 `getUserMedia`
- 自托管模型与 wasm 已包含在 `public/` 中，不依赖外部推理服务

## 4. 安装

```bash
cd flora
npm install
```

## 5. 本地运行

```bash
npm run dev
```

打开终端输出的地址，通常是：

```text
http://localhost:5173/
```

生产构建本地预览：

```bash
npm run build
npm run preview
```

### 使用流程

1. 等待花朵序列帧加载完成。
2. 点击页脚 `GESTURE / CAMERA` 打开摄像头窗口。
3. 点击「开启摄像头」并允许权限。
4. 手放入画面，摄像头窗口显示节点与 `OPENNESS`。
5. 可拖动窗口左边缘调整宽度。
6. 点击「画中画」或浏览器自带 PiP 图标进入原生 PiP；画面带节点。
7. 关闭窗口不会关闭摄像头；关闭摄像头后花朵保持最后状态。

## 6. 花朵素材替换方法

当前生产序列帧位于：

```text
public/frames/peony-halo/
  0001.webp ... 0120.webp
  manifest.json
```

### 直接替换

1. 准备透明背景 WebP 序列帧，建议保持：
   - 1280×720
   - 24 FPS
   - 120 帧
   - 透明 alpha
2. 替换 `public/frames/peony-halo` 下的 `NNNN.webp`。
3. 更新 `manifest.json`：
   - `direction` 必须是 `"closed-to-open"`（首帧闭合、末帧盛开）
   - `frameCount` 必须等于实际帧数
   - `frames` 必须按顺序列出文件名
   - `width` / `height` / `fps` 与实际帧一致
4. 刷新页面；加载器会校验帧数、方向和字段，方向错误会直接报错，不会反转手势含义。

> 生产配置给 `/frames/*` 设置了一年 immutable 缓存。替换素材时建议使用新的目录名或新的 manifest URL；如果沿用相同文件名，CDN/浏览器可能继续使用旧帧。

### 从视频生成

项目自带抽帧脚本：

```bash
npm run frames:extract -- \
  --input "video/your-flower.mp4" \
  --out public/frames/peony-halo \
  --fps 24 \
  --width 1280 \
  --quality 82
```

该脚本负责抽帧和生成 manifest；透明背景与暖灰光晕仍按现有 `scripts/halo_frames.py` 的流程处理，或直接替换已经处理好的 WebP。

## 7. 手势校准方法

校准是**可选精度优化**，不阻止手势控制。

1. 打开摄像头窗口。
2. 手部进入画面，确认 `HAND` 为 `TRACKING`。
3. 做最大捏合：拇指与食指尽量靠近，点击「记录闭合」。
4. 舒适张开五指，点击「记录张开」。
5. 数值差距至少 `0.12`，否则会提示校准无效。
6. 成功后 `CALIBRATION` 显示「已校准」，`OPENNESS` 端点会更接近 0% / 100%。

未校准时使用临时范围 `0.12–1.25`，仍然可以连续控制；页脚显示 `CALIBRATION ADVISED`。校准数据目前只保存在页面内存，刷新会重置。

## 8. 构建和部署

### 构建

```bash
npm run typecheck
npm run build
npm run preview
```

构建产物在 `dist/`。生产构建已验证：

- `dist/assets/*.js`、`*.css` 正常生成
- `dist/models/hand_landmarker.task` 存在
- `dist/mediapipe/wasm/*` 存在
- `dist/frames/peony-halo/*` 存在
- 页面路径都基于 `import.meta.env.BASE_URL`

### Vercel

项目包含 [vercel.json](vercel.json)。

手动步骤：

1. 将项目推送到 GitHub/GitLab。
2. 在 Vercel 导入仓库。
3. Framework Preset 选择 **Vite**。
4. Build Command：`npm run build`
5. Output Directory：`dist`
6. 部署后获得自动 HTTPS 域名。

或使用 CLI：

```bash
npx vercel
```

注意：当前环境没有部署凭据，**没有执行线上部署**。

### Netlify

项目包含 [netlify.toml](netlify.toml)。

手动步骤：

1. 将项目推送到 Git 仓库。
2. Netlify 新建站点并连接仓库。
3. Build command：`npm run build`
4. Publish directory：`dist`
5. 部署；HTTPS 自动启用。

或使用 CLI：

```bash
npm run build
npx netlify deploy --prod --dir=dist
```

注意：需要先在本地登录 Netlify；当前环境没有部署凭据。

### 部署后必须检查

- HTTPS 域名可以打开页面。
- `https://your-domain/models/hand_landmarker.task` 返回 200。
- `https://your-domain/mediapipe/wasm/vision_wasm_internal.wasm` 返回 200。
- 点击开启摄像头，浏览器能请求权限。
- 刷新页面，静态资源不出现 404。
- PiP：页面预览和原生 PiP 都带节点。
- 移动端（若访问）使用底部窗口；摄像头需要 HTTPS。

### 缓存策略

已配置：

- `/assets/*`、`/frames/*`、`/models/*`、`/mediapipe/*`：一年 immutable 缓存。
- `/index.html`：`no-cache`。
- `Permissions-Policy: camera=(self)`。

`manifest.json` 由应用以 `cache: "no-cache"` 请求，避免更新素材后继续使用旧清单。

## 9. 常见问题

### 摄像头打不开

- 必须是 `localhost` 或 HTTPS。
- 检查浏览器地址栏的摄像头权限。
- 关闭占用摄像头的其他应用。
- 首次开启需要加载约 7.8MB 模型和约 29MB wasm，稍等。

### 手势能识别但花朵不动

- 确认页脚状态是 `HAND DETECTED`，不是 `CALIBRATION ADVISED` 误导。
- 当前没有 Manual Mode；摄像头关闭时不会用鼠标控制花朵。
- 手部短暂离开时花朵保持最后状态，不是归零。
- 如果刚打开页面，等待序列帧加载完成。

### PiP 里没有节点

- 使用应用内「画中画」按钮，或浏览器在**合成视频**上的自带 PiP 图标。
- 原始摄像头 video 只是识别输入，不直接展示；PiP 应使用带节点的合成视频。
- 不要对隐藏的原始视频发起 PiP。

### 页面刷新后校准消失

校准目前只保存在内存中，刷新会回到临时范围；重新执行两点校准即可。

### 模型/wasm 404

确认部署产物中包含：

```text
dist/models/hand_landmarker.task
dist/mediapipe/wasm/
```

并确认构建时 `public/` 被完整复制。

### 构建成功但线上空白

- 确认部署的是 `dist/`。
- 确认站点根路径部署；如果部署在子路径，需要设置 Vite `base` 并同步 manifest/模型路径。
- 查看浏览器 Network 中 `assets/*.js` 是否 404。

## 10. 已知限制

- **内存**：120 张 1280×720 解码帧约 442MB（`120 × 1280 × 720 × 4`），另加浏览器和 MediaPipe 开销；面向桌面 Chrome/Edge，不建议低内存设备长期开启。
- **首次加载**：约 12.2MB WebP，帧加载和解码需要约 1–3 秒（本地/网络环境不同）；没有做逐帧分级预加载，以保证拖动时不会出现空洞帧。
- **MediaPipe 主线程开销**：模型初始化可能出现长任务，推理在低端 CPU/无 GPU 设备上会降低帧率；已限制为约 24 次/秒。
- **摄像头依赖**：没有 Manual Mode 兜底；摄像头不可用或拒绝授权时，花朵只能保持最后状态。
- **校准不持久化**：刷新页面后校准丢失。
- **PiP 浏览器支持**：依赖 `document.pictureInPictureEnabled` 和 `canvas.captureStream()`；不支持时应用内按钮禁用。
- **画中画节点是烘焙的**：节点已经合成进视频，不能在 PiP 中单独关闭或改样式。
- **合成预览开销**：摄像头窗口打开或 PiP 激活时持续合成；窗口关闭且 PiP 未激活时会暂停合成。
- **真实手感**：fake camera 只能验证管线、节点和 PiP；捏合/张开的最终手感需要真实摄像头验收。
- **素材未重新压缩**：为保持当前视觉质量，没有降低 WebP 分辨率或质量；如设备性能不足，可在 `frames:extract` 使用更小 `--width` 并重新处理 alpha。

## 性能记录

在本地生产构建、Edge headless、缓存禁用条件下采集（数值会随设备和网络变化）：

| 指标 | 结果 |
|---|---|
| 序列帧 | 120 张 WebP，约 12.2MB |
| 帧资源加载 | 约 1.0–2.5s |
| 首次可交互（加载遮罩消失、Canvas 有画面） | 约 2.4–3.3s |
| Canvas backing | 约 680×383（DPR 1 测试环境） |
| JS heap（加载后） | 约 4–15MB；不含解码图像内存 |
| 解码图像估算 | 约 442MB |
| 摄像头模型/wasm | 首次开启加载；模型约 7.8MB，wasm 约 29MB |
| 手势检测上限 | 24 次/秒 |
| 合成视频 | 24fps，640×480 源尺寸 |
| 摄像头窗口关闭 | 暂停合成绘制；手势识别继续 |

已实施的优化：

- 加载进度 UI 节流到约 10fps，避免 120 次 React 更新。
- 花朵 UI 状态与手势指标更新降至约 10fps；Canvas 仍按帧订阅绘制。
- 手势检测限制为 24fps。
- 合成视频限制为 24fps；摄像头窗口隐藏且 PiP 未激活时暂停合成。
- Canvas `imageSmoothingQuality` 使用 `medium`。
- 同一 manifest 使用模块级缓存，避免 React 重挂载重复请求/解码。
- 生产部署配置静态资源长缓存和 `index.html` no-cache。

未做的优化及原因：

- 没有盲目降低 WebP 分辨率或质量：当前 1280×720 是视觉验收基线，降分辨率会改变花朵细节。
- 没有做分级预加载：随机开合需要完整帧集，提前返回不完整序列会造成跳帧；当前保持“全部解码后进入”的一致性。
- 没有引入 Service Worker、Web Worker 或新的状态库：当前瓶颈主要是首次图片解码和 MediaPipe 初始化，增加复杂层不一定改善。
