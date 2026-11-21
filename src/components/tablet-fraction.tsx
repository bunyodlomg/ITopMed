import { fractionTone, parseTabletFraction } from "@/lib/tablet-fraction";

const TONE = { danger: "var(--danger)", warning: "var(--warning)", accent: "var(--accent)", success: "var(--success)" } as const;

function xy(cx: number, cy: number, r: number, turns: number): [string, string] {
  const a = turns * 2 * Math.PI - Math.PI / 2; // start at 12 o'clock, clockwise
  return [(cx + r * Math.cos(a)).toFixed(3), (cy + r * Math.sin(a)).toFixed(3)];
}
const point = (cx: number, cy: number, r: number, turns: number) => xy(cx, cy, r, turns).join(" ");

/** One tablet: outline, score lines for each piece, and the part to take filled in. */
function Tablet({ num, den, color }: { num: number; den: number; color: string }) {
  const c = 12;
  const r = 10;
  const part = num / den;
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" className="shrink-0" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
      {part >= 1 ? (
        <circle cx={c} cy={c} r={r} fill={color} />
      ) : (
        <path d={`M ${c} ${c} L ${point(c, c, r, 0)} A ${r} ${r} 0 ${part > 0.5 ? 1 : 0} 1 ${point(c, c, r, part)} Z`} fill={color} />
      )}
      {part < 1
        ? Array.from({ length: den }, (_, i) => {
            const [x2, y2] = xy(c, c, r, i / den);
            return <line key={i} x1={c} y1={c} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1" />;
          })
        : null}
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Picture of the dose when it is a tablet fraction (e.g. "1/4 tabletka" → a quarter
 * of a circle filled), coloured per piece so whole / half / quarter stand out.
 * Renders nothing for doses that are not a recognised fraction. Decorative: the
 * dose text next to it carries the meaning for screen readers.
 */
export function TabletFractionPicture({ dose }: { dose: string }) {
  const f = parseTabletFraction(dose);
  if (!f) return null;
  const color = TONE[fractionTone(f)];
  return (
    <span className="inline-flex items-center gap-0.5 align-middle text-text" data-tablet-fraction={`${f.whole} ${f.num}/${f.den}`}>
      {Array.from({ length: f.whole }, (_, i) => (
        <Tablet key={i} num={1} den={1} color={color} />
      ))}
      <Tablet num={f.num} den={f.den} color={color} />
    </span>
  );
}
