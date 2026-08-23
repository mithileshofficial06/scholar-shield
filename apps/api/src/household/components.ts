/**
 * Connected-component detection — step 3 of the household reconciliation engine
 * (PROJECT_REPORT.md §5 Tier 1).
 *
 * Linked pairs from `resolve.ts` form an undirected graph. Each connected
 * component is one candidate household.
 *
 * TRANSITIVITY IS THE RISK
 * ------------------------
 * Components are transitive by nature: if A links B and B links C, then A, B and
 * C are one household even though A and C were never compared. That is usually
 * what you want — a sibling pair plus a cousin sharing the address is one family.
 * It is also how a single bad edge contaminates a group: one spurious link
 * between two real households silently merges both, and every contradiction rule
 * downstream then fires across the seam.
 *
 * Two things contain that:
 *
 *   1. A reviewer can reject an edge (`household_edges.rejected_at`). Rejected
 *      edges are excluded here, so the component splits back apart without any
 *      data being deleted or rewritten.
 *   2. Components carry the edges that built them, so the dashboard can show
 *      *which* link produced a household rather than asserting the grouping.
 *
 * The algorithm is union-find with path compression and union by size — near
 * linear, deterministic, and small enough to read in one sitting.
 */

import type { PairResolution, ResolvedEdge } from './resolve.js';

export interface HouseholdComponent {
  /** Deterministic: the lexicographically smallest member id. */
  key: string;
  applicationIds: string[];
  edges: ResolvedEdge[];
}

class UnionFind {
  private parent = new Map<string, string>();
  private size = new Map<string, number>();

  add(id: string): void {
    if (this.parent.has(id)) return;
    this.parent.set(id, id);
    this.size.set(id, 1);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) {
      const next = this.parent.get(root);
      if (next === undefined) return root;
      root = next;
    }
    // Path compression — flatten the walked chain onto the root.
    let cursor = id;
    while (cursor !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    // Union by size keeps trees shallow.
    const sizeA = this.size.get(rootA) ?? 1;
    const sizeB = this.size.get(rootB) ?? 1;
    const [big, small] = sizeA >= sizeB ? [rootA, rootB] : [rootB, rootA];

    this.parent.set(small, big);
    this.size.set(big, sizeA + sizeB);
  }
}

export interface ComponentOptions {
  /**
   * Edges a reviewer has rejected, as `${aId}|${bId}|${matchField}` keys. Rejected
   * edges do not participate, so a household splits back apart on rejection
   * without anything being deleted.
   */
  rejectedEdgeKeys?: ReadonlySet<string>;
}

export function edgeKey(edge: ResolvedEdge): string {
  // Sorted so the key is stable regardless of which side was compared first.
  const [a, b] = [edge.applicationAId, edge.applicationBId].sort();
  return `${a}|${b}|${edge.matchField}`;
}

/**
 * Group applications into households.
 *
 * Every id in `allApplicationIds` appears in the output, including those with no
 * links at all — a household of one is still a household, and omitting singletons
 * would make the caller reconstruct them.
 */
export function detectComponents(
  allApplicationIds: readonly string[],
  pairs: readonly PairResolution[],
  options: ComponentOptions = {},
): HouseholdComponent[] {
  const rejected = options.rejectedEdgeKeys ?? new Set<string>();
  const uf = new UnionFind();

  for (const id of allApplicationIds) uf.add(id);

  const activeEdges: ResolvedEdge[] = [];

  for (const pair of pairs) {
    if (!pair.linked) continue;

    const surviving = pair.edges.filter((edge) => !rejected.has(edgeKey(edge)));
    // A pair whose every supporting edge was rejected is no longer a link, even
    // though the original resolution said it was.
    if (surviving.length === 0) continue;

    uf.add(pair.applicationAId);
    uf.add(pair.applicationBId);
    uf.union(pair.applicationAId, pair.applicationBId);

    activeEdges.push(...surviving);
  }

  const byRoot = new Map<string, { ids: string[]; edges: ResolvedEdge[] }>();

  for (const id of allApplicationIds) {
    const root = uf.find(id);
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = { ids: [], edges: [] };
      byRoot.set(root, bucket);
    }
    bucket.ids.push(id);
  }

  for (const edge of activeEdges) {
    const root = uf.find(edge.applicationAId);
    byRoot.get(root)?.edges.push(edge);
  }

  const components: HouseholdComponent[] = [];
  for (const bucket of byRoot.values()) {
    const ids = [...bucket.ids].sort();
    components.push({
      // Smallest member id, not the union-find root — the root depends on union
      // order, and a household key that moves between runs is useless for
      // comparing one reconciliation against the next.
      key: ids[0]!,
      applicationIds: ids,
      edges: bucket.edges,
    });
  }

  return components.sort((a, b) => a.key.localeCompare(b.key));
}

/** The component containing a given application, or null if it is not present. */
export function componentFor(
  components: readonly HouseholdComponent[],
  applicationId: string,
): HouseholdComponent | null {
  return components.find((c) => c.applicationIds.includes(applicationId)) ?? null;
}
