import type { CSSProperties } from 'react';

interface BloomControlProps {
  openness: number;
  disabled: boolean;
  onSeek: (openness: number) => void;
}

/**
 * 艺术界面中的极简开合控制：一条 1px 细线 + 小圆点。
 * 后续手势阶段可以复用同一个 openness 接口。
 */
export function BloomControl({
  openness,
  disabled,
  onSeek,
}: BloomControlProps) {
  const percent = Math.round(openness * 100);
  const style = {
    '--bloom-progress': `${openness * 100}%`,
  } as CSSProperties;

  return (
    <div className="bloom-control">
      <div className="bloom-meta">
        <span className="bloom-label">OPENNESS</span>
        <span className="bloom-value" data-testid="openness-value">
          {String(percent).padStart(2, '0')}
          <span className="bloom-unit">%</span>
        </span>
      </div>

      <input
        className="bloom-range"
        data-testid="openness-range"
        type="range"
        min={0}
        max={1000}
        step={1}
        value={Math.round(openness * 1000)}
        style={style}
        disabled={disabled}
        aria-label="花朵开放度"
        aria-valuetext={`${percent}%`}
        onChange={(event) => onSeek(Number(event.target.value) / 1000)}
      />

      <div className="bloom-legend" aria-hidden="true">
        <span>CLOSED</span>
        <span>DRAG TO BLOOM</span>
        <span>BLOOM</span>
      </div>
    </div>
  );
}
