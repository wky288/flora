import { useEffect, useState } from 'react';
import { ErrorState } from './components/ErrorState';
import { FlowerCanvas } from './components/FlowerCanvas';
import { GestureLab } from './components/GestureLab';
import { LoadingOverlay } from './components/LoadingOverlay';
import {
  DEFAULT_MOTION_PRESET,
  MOTION_PRESETS,
  type MotionPreset,
} from './config/motion';
import { useHandGesture } from './hooks/useHandGesture';
import { useFlowerAnimation } from './hooks/useFlowerAnimation';
import { useFlowerFrames } from './hooks/useFlowerFrames';

const MANIFEST_URL = `${import.meta.env.BASE_URL}frames/peony-halo/manifest.json`;

/** 首屏停留在接近盛开的姿态，保持参考图中的完整花形。 */
const INITIAL_OPENNESS = 0.9;

function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <g
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2.5v19" />
        <path d="M2.5 12h19" />
        <path d="m5.3 5.3 13.4 13.4" />
        <path d="m18.7 5.3-13.4 13.4" />
        <path d="M12 2.5c2.2 3.1 2.2 6.4 0 9.5-2.2-3.1-2.2-6.4 0-9.5Z" />
        <path d="M12 21.5c-2.2-3.1-2.2-6.4 0-9.5 2.2 3.1 2.2 6.4 0 9.5Z" />
      </g>
    </svg>
  );
}

export default function App() {
  const { sequence, progress, error, isLoading, retry } =
    useFlowerFrames(MANIFEST_URL);
  const gesture = useHandGesture();
  const frameCount = sequence?.manifest.frameCount ?? 0;
  const [cameraOpen, setCameraOpen] = useState(false);
  const [motionPreset, setMotionPreset] =
    useState<MotionPreset>(DEFAULT_MOTION_PRESET);
  const motion = MOTION_PRESETS[motionPreset];
  const animation = useFlowerAnimation({
    frameCount,
    initialOpenness: INITIAL_OPENNESS,
    motion,
  });

  // 手势始终驱动花朵；校准只作为精度优化，不再是使用前提。
  useEffect(() => {
    if (gesture.normalized === null) return;
    animation.setTarget(gesture.normalized);
  }, [animation.setTarget, gesture.normalized]);

  const cameraReady = gesture.cameraStatus === 'ready';
  const footerStatus = !cameraReady
    ? gesture.cameraStatus === 'error'
      ? 'CAMERA ERROR'
      : 'CAMERA OFF'
    : gesture.calibration === null
      ? 'CALIBRATION ADVISED'
      : gesture.handStatus === 'tracking'
        ? 'HAND DETECTED'
        : 'NO HAND DETECTED';
  const footerTone =
    gesture.cameraStatus === 'error'
      ? 'is-error'
      : gesture.handStatus === 'tracking'
        ? 'is-live'
        : gesture.cameraStatus === 'ready'
          ? 'is-ready'
          : 'is-idle';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <span className="brand-name">FLORA</span>
            <span className="brand-tagline">FORM IN MOTION</span>
          </div>
        </div>

        <nav className="studies" aria-label="花卉研究">
          <span className="studies-label">STUDIES</span>
          <span className="studies-divider" aria-hidden="true" />
          <span className="studies-current">
            <span className="studies-index">01</span> / PEONY
          </span>
        </nav>
      </header>

      <main className="stage">
        <section className="intro" aria-labelledby="page-title">
          <p className="kicker">
            <span className="kicker-line" aria-hidden="true" />
            BLOOM / 01
          </p>
          <h1 id="page-title" className="display-title">
            <span>In full</span>
            <em>bloom.</em>
          </h1>
          <p className="subtitle">让花在指尖绽放。</p>
        </section>

        <section className="flower-column" aria-label="牡丹花朵">
          <div className="flower-wrap">
            <div className="flower-frame">
              <FlowerCanvas sequence={sequence} animation={animation} />
              {isLoading && <LoadingOverlay progress={progress} />}
              {error && <ErrorState message={error} onRetry={retry} />}
            </div>
          </div>
        </section>

        <aside className="study-info" aria-label="花卉信息">
          <p className="study-index">
            01 <span>/ FLOWER STUDY</span>
          </p>
          <h2 className="flower-name">牡丹</h2>
          <p className="flower-latin">
            PEONY <span>· Paeonia</span>
          </p>
          <span className="info-rule" aria-hidden="true" />
          <p className="info-label">FLOWER LANGUAGE</p>
          <p className="info-meaning">富贵 · 圆满</p>
        </aside>
      </main>

      <GestureLab
        gesture={gesture}
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        showMotionPreset={import.meta.env.DEV}
        motionPreset={motionPreset}
        onMotionPresetChange={setMotionPreset}
      />

      <footer className="footer">
        <p className="gesture-copy">捏合手指，控制花朵开合</p>
        <button
          className="footer-center footer-gesture"
          type="button"
          aria-expanded={cameraOpen}
          aria-controls="camera-drawer"
          onClick={() => setCameraOpen((value) => !value)}
        >
          <span className={`footer-gesture-dot ${footerTone}`} aria-hidden="true" />
          <span>{cameraOpen ? 'CLOSE PANEL' : 'GESTURE / CAMERA'}</span>
          <span className="footer-gesture-state">{footerStatus}</span>
        </button>
        <p className="footer-meta">视觉研究 / VISUAL STUDY</p>
      </footer>
    </div>
  );
}
