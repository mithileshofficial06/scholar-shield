/**
 * The product, in one picture.
 *
 * Three applications filed separately, resolved into one household by fuzzy
 * matching on guardian name and address — and the contradiction that only
 * becomes visible once they are sitting next to each other. Nothing else on the
 * page shows what the engine actually does; a list of pipeline steps describes
 * it, which is not the same thing.
 *
 * Drawn as inline SVG rather than an image so it inherits the theme tokens,
 * stays sharp at any zoom, and remains a few hundred bytes.
 */

interface Node {
  id: string;
  ref: string;
  name: string;
  income: string;
  x: number;
}

const NODE_Y = 108;
const NODE_W = 196;
const NODE_H = 104;

const NODES: Node[] = [
  { id: 'a', ref: 'APP-0141', name: 'Karthik Raman', income: '₹96,000', x: 40 },
  { id: 'b', ref: 'APP-0207', name: 'Gowri Raman', income: '₹92,500', x: 302 },
  { id: 'c', ref: 'APP-0233', name: 'Bhuvana Raman', income: '₹1,78,000', x: 564 },
];

export function HouseholdDiagram() {
  const midY = NODE_Y + NODE_H / 2;
  const bottomY = NODE_Y + NODE_H;

  const leftCentre = NODES[0]!.x + NODE_W / 2;
  const rightCentre = NODES[2]!.x + NODE_W / 2;

  return (
    <svg
      viewBox="0 0 800 392"
      role="img"
      aria-label="Three separately filed scholarship applications resolved into one household. Two declare about ninety-five thousand rupees; the third declares one lakh seventy-eight thousand. The engine flags the contradiction."
    >
      {/* Household boundary */}
      <rect
        x="16"
        y="64"
        width="768"
        height="196"
        fill="none"
        stroke="var(--line-2)"
        strokeWidth="1"
        strokeDasharray="4 4"
      />
      <text x="16" y="52" fill="var(--faint)" fontSize="10.5" letterSpacing="1.6">
        HOUSEHOLD · H-2026-0184 · RESOLVED FROM 3 APPLICATIONS
      </text>

      {/* Resolution edges — how the household was built */}
      {[
        { from: 0, to: 1, label: 'guardian_name · 0.95' },
        { from: 1, to: 2, label: 'address · 0.98' },
      ].map(({ from, to, label }) => {
        const x1 = NODES[from]!.x + NODE_W;
        const x2 = NODES[to]!.x;
        return (
          <g key={label}>
            <line x1={x1} y1={midY} x2={x2} y2={midY} stroke="var(--line-2)" strokeWidth="1" />
            <circle cx={(x1 + x2) / 2} cy={midY} r="2.5" fill="var(--signal)" />
            <text
              x={(x1 + x2) / 2}
              y={midY - 14}
              fill="var(--faint)"
             
              fontSize="9.5"
              textAnchor="middle"
              letterSpacing="0.8"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* Application nodes */}
      {NODES.map((node) => {
        const isOutlier = node.id === 'c';
        return (
          <g key={node.id}>
            <rect
              x={node.x}
              y={NODE_Y}
              width={NODE_W}
              height={NODE_H}
              fill="var(--panel-2)"
              stroke={isOutlier ? 'var(--high)' : 'var(--line-2)'}
              strokeWidth="1"
            />
            <text
              x={node.x + 16}
              y={NODE_Y + 26}
              fill="var(--faint)"
             
              fontSize="9.5"
              letterSpacing="1.2"
            >
              {node.ref}
            </text>
            <text
              x={node.x + 16}
              y={NODE_Y + 52}
              fill="var(--text)"
              className="is-display"
              fontSize="15"
              fontWeight="700"
              letterSpacing="-0.2"
            >
              {node.name}
            </text>
            <text
              x={node.x + 16}
              y={NODE_Y + 80}
              fill={isOutlier ? 'var(--high)' : 'var(--dim)'}
             
              fontSize="13"
              fontWeight={isOutlier ? 700 : 400}
            >
              {node.income}
            </text>
          </g>
        );
      })}

      {/* The finding: an arc under the household joining the two extremes */}
      <path
        d={`M ${leftCentre} ${bottomY} C ${leftCentre} ${bottomY + 118}, ${rightCentre} ${bottomY + 118}, ${rightCentre} ${bottomY}`}
        fill="none"
        stroke="var(--high)"
        strokeWidth="1.5"
      />
      <rect x="248" y="316" width="304" height="26" fill="var(--canvas)" />
      <text
        x="400"
        y="334"
        fill="var(--high)"
       
        fontSize="10.5"
        textAnchor="middle"
        letterSpacing="1.3"
      >
        SIBLING_INCOME_CONTRADICTION · Δ ₹82,000
      </text>

      {/* Instrument ticks — corner registration marks */}
      {[
        [16, 64],
        [784, 64],
        [16, 260],
        [784, 260],
      ].map(([x, y]) => (
        <g key={`${x}-${y}`} stroke="var(--line-2)" strokeWidth="1">
          <line x1={x! - 4} y1={y!} x2={x! + 4} y2={y!} />
          <line x1={x!} y1={y! - 4} x2={x!} y2={y! + 4} />
        </g>
      ))}
    </svg>
  );
}
