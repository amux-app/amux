import { useId } from 'react';

interface SparklineProps {
  points: number[];
  color: string;
  dotColor?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  showEndDot?: boolean;
  className?: string;
}

interface Point {
  x: number;
  y: number;
}

export function Sparkline({
  points,
  color,
  dotColor,
  width = 44,
  height = 14,
  strokeWidth = 1.5,
  showEndDot = false,
  className,
}: SparklineProps) {
  const gradientId = useId();
  const pad = strokeWidth + 1;
  const coords = toCoords(points, width, height, pad);
  const last = coords[coords.length - 1];
  const baseY = (height - pad).toFixed(2);

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
  const area = `${line} L ${last.x.toFixed(2)},${baseY} L ${coords[0].x.toFixed(2)},${baseY} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {showEndDot && <circle cx={last.x} cy={last.y} r={strokeWidth} fill={dotColor ?? color} />}
    </svg>
  );
}

function toCoords(points: number[], width: number, height: number, pad: number): Point[] {
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  if (points.length <= 1) {
    const y = pad + innerH / 2;
    return [{ x: pad, y }, { x: width - pad, y }];
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min;
  const stepX = innerW / (points.length - 1);
  return points.map((value, index) => ({
    x: pad + index * stepX,
    y: range === 0 ? pad + innerH / 2 : pad + innerH - ((value - min) / range) * innerH,
  }));
}
