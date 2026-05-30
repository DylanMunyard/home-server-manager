import { useMemo } from 'react';
import { scaleLinear } from '@visx/scale';
import { AreaClosed, LinePath, Line } from '@visx/shape';
import { curveMonotoneX } from '@visx/curve';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { Group } from '@visx/group';
import { useMeasure } from './useMeasure.ts';

export type Point = { x: number; y: number }; // x = unix ms, y = value

type Props = {
  data: Point[];
  height: number;
  /** Fixed y-axis top (e.g. 100 for %). Omit to autoscale to the data. */
  yMax?: number;
  /** Draw a faint reference line + flip the colour to --err past it. */
  threshold?: number;
  /** 'spark' = bare line+fill; 'full' = axes + gridless ticks. */
  variant?: 'spark' | 'full';
};

const MARGIN = { spark: { t: 2, r: 1, b: 2, l: 1 }, full: { t: 8, r: 8, b: 20, l: 34 } };

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MetricChart({ data, height, yMax, threshold, variant = 'spark' }: Props) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const m = MARGIN[variant];

  const { xScale, yScale, innerW, innerH, over } = useMemo(() => {
    const innerW = Math.max(0, width - m.l - m.r);
    const innerH = Math.max(0, height - m.t - m.b);
    const xs = data.map((d) => d.x);
    const x0 = xs.length ? Math.min(...xs) : 0;
    const x1 = xs.length ? Math.max(...xs) : 1;
    const dataMax = data.length ? Math.max(...data.map((d) => d.y)) : 1;
    const top = yMax ?? Math.max(dataMax * 1.15, 1);
    const last = data.length ? data[data.length - 1].y : 0;
    return {
      innerW, innerH,
      over: threshold !== undefined && last >= threshold,
      xScale: scaleLinear({ domain: [x0, x1 === x0 ? x0 + 1 : x1], range: [0, innerW] }),
      yScale: scaleLinear({ domain: [0, top], range: [innerH, 0] }),
    };
  }, [data, width, height, yMax, threshold, m.l, m.r, m.t, m.b]);

  const stroke = over ? 'var(--err)' : 'var(--ink)';
  const fill = over ? 'var(--err)' : 'var(--accent)';

  return (
    <div ref={ref} className="mchart" style={{ width: '100%', height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="metric trend">
          <Group left={m.l} top={m.t}>
            {data.length > 0 && (
              <>
                <AreaClosed
                  data={data}
                  x={(d) => xScale(d.x)}
                  y={(d) => yScale(d.y)}
                  yScale={yScale}
                  curve={curveMonotoneX}
                  fill={fill}
                  fillOpacity={0.18}
                />
                <LinePath
                  data={data}
                  x={(d) => xScale(d.x)}
                  y={(d) => yScale(d.y)}
                  curve={curveMonotoneX}
                  stroke={stroke}
                  strokeWidth={1.25}
                />
              </>
            )}
            {threshold !== undefined && (yMax ?? Infinity) >= threshold && (
              <Line
                from={{ x: 0, y: yScale(threshold) }}
                to={{ x: innerW, y: yScale(threshold) }}
                stroke="var(--err)"
                strokeWidth={1}
                strokeDasharray="3,3"
                strokeOpacity={0.5}
              />
            )}
            {variant === 'full' && (
              <>
                <AxisLeft
                  scale={yScale}
                  numTicks={4}
                  stroke="var(--line-soft)"
                  tickStroke="var(--line-soft)"
                  tickLabelProps={() => ({ fill: 'var(--ink-3)', fontSize: 10, fontFamily: 'inherit', dx: -2, dy: 3, textAnchor: 'end' })}
                />
                <AxisBottom
                  top={innerH}
                  scale={xScale}
                  numTicks={Math.max(2, Math.floor(innerW / 90))}
                  tickFormat={(v) => hhmm(Number(v))}
                  stroke="var(--line-soft)"
                  tickStroke="var(--line-soft)"
                  tickLabelProps={() => ({ fill: 'var(--ink-3)', fontSize: 10, fontFamily: 'inherit', dy: 2, textAnchor: 'middle' })}
                />
              </>
            )}
          </Group>
        </svg>
      )}
    </div>
  );
}
