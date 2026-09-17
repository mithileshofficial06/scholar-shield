/**
 * The product working, as a loop.
 *
 * Three applications arrive separately, fuzzy matching joins them into one
 * household, and only then does the income contradiction between two of them
 * become visible. The animation is the argument of the whole project: the
 * fraud is invisible per application and obvious per household.
 *
 * Pure SVG + CSS keyframes (see `.hg-*` in globals.css), so it costs no
 * JavaScript and no re-renders. Every element runs on the same 12s cycle with
 * its own keyframe percentages, which keeps the phases in lock-step forever;
 * staggering with animation-delay would drift the fade-outs across the loop.
 * Under reduced motion the diagram shows its final, fully-resolved state.
 */

interface GraphNode {
  key: 'a' | 'b' | 'c';
  ref: string;
  name: string;
  income: string;
  x: number;
  y: number;
}

const NODE_W = 180;
const NODE_H = 92;

const NODES: GraphNode[] = [
  { key: 'a', ref: 'APP-0141', name: 'Karthik Raman', income: '₹96,000', x: 40, y: 48 },
  { key: 'b', ref: 'APP-0207', name: 'Gowri Raman', income: '₹92,500', x: 300, y: 48 },
  { key: 'c', ref: 'APP-0233', name: 'Bhuvana Raman', income: '₹1,78,000', x: 170, y: 226 },
];

const STEPS = ['Filed separately', 'Household linked', 'Contradiction flagged'];

export function HeroGraph() {
  return (
    <div className="hero-graph card">
      <div className="hg-head">
        <div>
          <p className="hg-title">Household resolution</p>
          <p className="hg-sub data">H-2026-0184 · cycle 2026</p>
        </div>
        <span className="hg-live">
          <span className="live-dot" aria-hidden="true" />
          Live engine
        </span>
      </div>

      <svg
        className="hg-svg"
        viewBox="0 0 520 410"
        role="img"
        aria-label="Three separately filed applications resolve into one household by guardian name and address. Two declare about ninety-five thousand rupees and the third one lakh seventy-eight thousand, so the engine flags a sibling income contradiction."
      >
        <defs>
          {/* userSpaceOnUse: a horizontal line has a zero-height bounding box, and a
              bounding-box gradient on it renders nothing at all. */}
          <linearGradient id="hg-edge" gradientUnits="userSpaceOnUse" x1="40" y1="0" x2="480" y2="0">
            <stop offset="0" stopColor="#22d3ee" />
            <stop offset="1" stopColor="#7c8cff" />
          </linearGradient>
        </defs>

        <rect className="hg-boundary" x="16" y="16" width="488" height="328" rx="20" pathLength={1} />

        <line className="hg-edge hg-edge-1" x1="220" y1="94" x2="300" y2="94" pathLength={1} />
        <line className="hg-edge hg-edge-2" x1="362" y1="140" x2="318" y2="226" pathLength={1} />

        <text className="hg-label hg-label-1" x="260" y="38" textAnchor="middle">
          guardian 0.95
        </text>
        <text className="hg-label hg-label-2" x="358" y="196">
          address 0.98
        </text>

        <path className="hg-arc" d="M92 140 C 50 212, 92 272, 170 272" pathLength={1} />
        <text className="hg-delta" x="104" y="196">
          Δ ₹82,000
        </text>

        {NODES.map((node) => (
          <g key={node.key} className={`hg-node hg-node-${node.key}`}>
            <rect
              className={node.key === 'c' ? 'hg-card hg-card-alert' : 'hg-card'}
              x={node.x}
              y={node.y}
              width={NODE_W}
              height={NODE_H}
              rx="14"
            />
            <text className="hg-ref" x={node.x + 16} y={node.y + 26}>
              {node.ref}
            </text>
            <text className="hg-name" x={node.x + 16} y={node.y + 52}>
              {node.name}
            </text>
            <text
              className={node.key === 'c' ? 'hg-income hg-income-alert' : 'hg-income'}
              x={node.x + 16}
              y={node.y + 76}
            >
              {node.income}
            </text>
          </g>
        ))}

        <g className="hg-chip">
          <rect x="95" y="362" width="330" height="36" rx="18" />
          <text x="260" y="385" textAnchor="middle">
            SIBLING_INCOME_CONTRADICTION · +40
          </text>
        </g>
      </svg>

      <ol className="hg-steps">
        {STEPS.map((step, index) => (
          <li key={step} className={`hg-step hg-step-${index + 1}`}>
            <span className="hg-step-num">{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}
