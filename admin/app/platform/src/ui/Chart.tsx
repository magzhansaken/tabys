/*
 * График без библиотек: одна ломаная, оси, даты и наведение.
 *
 * Раньше это была голая линия без единой подписи — по ней нельзя было
 * сказать ни «сколько», ни «когда». Пять точек не стоят тяжёлого
 * пакета, а вот подписи и подсказка при наведении стоят.
 */
import { useRef, useState } from 'react';

export type ChartPoint = { label: string; value: number };

const W = 640;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 12;

export function Chart({ points, height = 170, format, title }: {
  points: ChartPoint[];
  height?: number;
  /** Как показывать значение: деньги или просто число. */
  format: (v: number) => string;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  if (points.length < 2) {
    return <p className="note">Данных пока мало — график появится через пару дней.</p>;
  }

  const plotH = height - 34;
  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || Math.max(max, 1);
  const lo = Math.max(0, min - span * 0.15);
  const hi = max + span * 0.15;

  const x = (i: number) => PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo || 1)) * (plotH - PAD_T);

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${PAD_L},${plotH} ${line} ${(W - PAD_R).toFixed(1)},${plotH}`;

  const mid = Math.floor((points.length - 1) / 2);
  const at = hover !== null ? points[hover] : undefined;

  const track = (clientX: number) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const rel = (clientX - r.left) / r.width;
    const i = Math.round(rel * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  return (
    <div className="chart" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={title}
        onPointerMove={(e) => track(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={PAD_L} y1={PAD_T} x2={W - PAD_R} y2={PAD_T} className="axis soft" />
        <line x1={PAD_L} y1={(PAD_T + plotH) / 2} x2={W - PAD_R} y2={(PAD_T + plotH) / 2} className="axis soft" />
        <line x1={PAD_L} y1={plotH} x2={W - PAD_R} y2={plotH} className="axis" />

        <polygon points={area} className="fill" />
        <polyline points={line} className="line" />

        {hover !== null && at && (
          <>
            <line x1={x(hover)} y1={PAD_T} x2={x(hover)} y2={plotH} className="cursor" />
            <circle cx={x(hover)} cy={y(at.value)} r="4.5" className="dot" />
          </>
        )}

        <text x={PAD_L} y={PAD_T - 2} className="tick">{format(Math.round(hi))}</text>
        <text x={PAD_L} y={plotH + 16} className="tick">{points[0]?.label ?? ''}</text>
        <text x={W / 2} y={plotH + 16} className="tick mid">{points[mid]?.label ?? ''}</text>
        <text x={W - PAD_R} y={plotH + 16} className="tick end">{points[points.length - 1]?.label ?? ''}</text>
      </svg>

      {hover !== null && at && (
        <div
          className="chart-tip"
          style={{ left: `${(x(hover) / W) * 100}%` }}
        >
          <b>{format(at.value)}</b>
          <i>{at.label}</i>
        </div>
      )}
    </div>
  );
}
