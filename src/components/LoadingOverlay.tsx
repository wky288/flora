import type { FrameLoadProgress } from '../types/flower';

interface LoadingOverlayProps {
  progress: FrameLoadProgress;
}

/** 覆盖在花朵画面上的极简加载层，显示真实帧数与百分比。 */
export function LoadingOverlay({ progress }: LoadingOverlayProps) {
  const hasTotal = progress.total > 0;

  return (
    <div
      className="stage-overlay"
      role="status"
      aria-live="polite"
      data-testid="loading-overlay"
    >
      <p className="overlay-kicker">Preparing the bloom</p>
      <div
        className={`load-track${hasTotal ? '' : ' is-indeterminate'}`}
        aria-hidden="true"
      >
        <span style={hasTotal ? { width: `${progress.percent}%` } : undefined} />
      </div>
      <p className="overlay-meta">
        {hasTotal
          ? `载入花瓣 ${progress.loaded} / ${progress.total} 帧 · ${progress.percent}%`
          : '正在读取帧清单…'}
      </p>
    </div>
  );
}
