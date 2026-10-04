// The assurance knowledge graph engine. Deterministic, content-addressed (node/edge ids are a hash
// of their identity, so building the same facts twice yields the same graph), fail-closed on bad
// input (unknown node/edge types and illegal endpoint type pairs are rejected on insert, never
// silently kept). Queries implement traceability, change-impact, blast-radius, regression
// selection, root-cause correlation and release assurance on top of one traversal core.
import { sha256Hex } from "@uaap/core";
import {
  EDGE_TYPES,
  EdgeType,
  NodeType,
  OPEN_FINDING_STATUSES,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
} from "./types.js";

export interface NodeSpec {
  readonly type: NodeType;
  readonly key: string;
  readonly label?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface ImpactNode {
  readonly node: GraphNode;
  readonly depth: number;
}
export interface ImpactResult {
  readonly seeds: readonly string[];
  readonly impacted: readonly ImpactNode[];
  readonly byType: Readonly<Record<string, number>>;
  readonly total: number;
}

export interface TraceStep {
  readonly node: GraphNode;
  /** The edge traversed to reach this node from the previous step (undefined for the first). */
  readonly via?: { readonly type: EdgeType; readonly id: string; readonly forward: boolean };
}

export interface RootCauseCandidate {
  readonly node: GraphNode;
  readonly distance: number;
  readonly relation: string;
}

export interface ReleaseAssuranceReport {
  readonly releaseId: string;
  readonly releaseKey: string;
  readonly shipped: readonly { readonly id: string; readonly type: NodeType; readonly key: string }[];
  readonly requirements: readonly {
    readonly id: string;
    readonly key: string;
    readonly validated: boolean;
    readonly passingEvidence: boolean;
    readonly status: "ASSURED" | "GAP";
  }[];
  readonly untraceableShipped: readonly { readonly id: string; readonly type: NodeType; readonly key: string }[];
  readonly blockingFindings: readonly {
    readonly id: string;
    readonly key: string;
    readonly status: string;
    readonly severity: string | undefined;
    readonly affects: readonly string[];
  }[];
  readonly verdict: "ASSURED" | "NOT_ASSURED";
  readonly reasons: readonly string[];
}

function isPassingEvidence(node: GraphNode): boolean {
  const a = node.attrs ?? {};
  const outcome = String((a as Record<string, unknown>).outcome ?? (a as Record<string, unknown>).verdict ?? "").toUpperCase();
  return outcome === "PASS" || outcome === "PASSED" || (a as Record<string, unknown>).passed === true;
}

export class KnowledgeGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly out = new Map<string, GraphEdge[]>();
  private readonly in = new Map<string, GraphEdge[]>();
  private readonly edges = new Map<string, GraphEdge>();

  /** Deterministic, content-addressed node id (stable across runs for the same type+key). */
  static nodeId(type: NodeType, key: string): string {
    return `N_${sha256Hex(`${type}\u0000${key}`).slice(0, 24)}`;
  }
  static edgeId(type: EdgeType, from: string, to: string): string {
    return `E_${sha256Hex(`${type}\u0000${from}\u0000${to}`).slice(0, 24)}`;
  }

  /** Add (or merge attrs into) a node. Idempotent per (type, key). Returns the node id. */
  addNode(spec: NodeSpec): string {
    if (!(spec.type in NodeType)) throw new Error(`knowledge-graph: unknown node type "${spec.type}"`);
    if (typeof spec.key !== "string" || spec.key.length === 0) throw new Error("knowledge-graph: node key must be a non-empty string");
    const id = KnowledgeGraph.nodeId(spec.type, spec.key);
    const existing = this.nodes.get(id);
    const node: GraphNode = {
      id,
      type: spec.type,
      key: spec.key,
      ...(spec.label !== undefined || existing?.label !== undefined ? { label: spec.label ?? existing?.label } : {}),
      ...(spec.attrs || existing?.attrs ? { attrs: { ...(existing?.attrs ?? {}), ...(spec.attrs ?? {}) } } : {}),
    };
    this.nodes.set(id, node);
    if (!this.out.has(id)) this.out.set(id, []);
    if (!this.in.has(id)) this.in.set(id, []);
    return id;
  }

  /** Add an edge. Validates the type and the endpoint node types against the edge contract. */
  addEdge(type: EdgeType, from: string, to: string, attrs?: Readonly<Record<string, unknown>>): string {
    const desc = EDGE_TYPES[type];
    if (!desc) throw new Error(`knowledge-graph: unknown edge type "${type}"`);
    const f = this.nodes.get(from);
    const t = this.nodes.get(to);
    if (!f) throw new Error(`knowledge-graph: edge ${type} references missing source node "${from}"`);
    if (!t) throw new Error(`knowledge-graph: edge ${type} references missing target node "${to}"`);
    if (desc.from.length > 0 && !desc.from.includes(f.type))
      throw new Error(`knowledge-graph: ${type} source must be one of [${desc.from.join(", ")}], got ${f.type}`);
    if (desc.to.length > 0 && !desc.to.includes(t.type))
      throw new Error(`knowledge-graph: ${type} target must be one of [${desc.to.join(", ")}], got ${t.type}`);
    const id = KnowledgeGraph.edgeId(type, from, to);
    if (this.edges.has(id)) return id; // idempotent
    const edge: GraphEdge = { id, type, from, to, ...(attrs ? { attrs } : {}) };
    this.edges.set(id, edge);
    this.out.get(from)!.push(edge);
    this.in.get(to)!.push(edge);
    return id;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }
  /** Resolve a node id from its (type, key) — convenience for callers that only know the key. */
  resolve(type: NodeType, key: string): string | undefined {
    const id = KnowledgeGraph.nodeId(type, key);
    return this.nodes.has(id) ? id : undefined;
  }
  nodeCount(): number {
    return this.nodes.size;
  }
  edgeCount(): number {
    return this.edges.size;
  }

  /** Impact neighbours of a node: the nodes a CHANGE at `id` propagates to, per edge direction. */
  private impactNeighbours(id: string): string[] {
    const next: string[] = [];
    for (const e of this.out.get(id) ?? []) {
      const d = EDGE_TYPES[e.type].propagatesImpact;
      if (d === "forward" || d === "both") next.push(e.to);
    }
    for (const e of this.in.get(id) ?? []) {
      const d = EDGE_TYPES[e.type].propagatesImpact;
      if (d === "backward" || d === "both") next.push(e.from);
    }
    return next;
  }

  /**
   * Change impact / blast radius. Returns every node transitively affected by a change to any seed
   * (seeds themselves excluded), with the shortest hop distance. maxDepth bounds the radius
   * (undefined = unbounded = full blast radius).
   */
  changeImpact(seedIds: readonly string[], opts: { readonly maxDepth?: number } = {}): ImpactResult {
    const maxDepth = opts.maxDepth ?? Infinity;
    const seeds = seedIds.filter((s) => this.nodes.has(s));
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const s of seeds) {
      depth.set(s, 0);
      queue.push(s);
    }
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      const d = depth.get(cur)!;
      if (d >= maxDepth) continue;
      for (const nb of this.impactNeighbours(cur)) {
        if (!depth.has(nb)) {
          depth.set(nb, d + 1);
          queue.push(nb);
        }
      }
    }
    const seedSet = new Set(seeds);
    const impacted: ImpactNode[] = [];
    for (const [id, d] of depth) {
      if (seedSet.has(id)) continue;
      impacted.push({ node: this.nodes.get(id)!, depth: d });
    }
    impacted.sort((a, b) => a.depth - b.depth || (a.node.id < b.node.id ? -1 : 1));
    const byType: Record<string, number> = {};
    for (const it of impacted) byType[it.node.type] = (byType[it.node.type] ?? 0) + 1;
    return { seeds, impacted, byType, total: impacted.length };
  }

  /** Full blast radius = unbounded change impact. */
  blastRadius(seedIds: readonly string[]): ImpactResult {
    return this.changeImpact(seedIds, {});
  }

  /**
   * Regression selection: the TEST nodes that must re-run when the given nodes change. A test is
   * selected if it (transitively) covers/validates anything in the change's blast radius.
   */
  regressionSelection(changedIds: readonly string[]): GraphNode[] {
    const impact = this.changeImpact(changedIds, {});
    const tests = impact.impacted.filter((i) => i.node.type === NodeType.TEST).map((i) => i.node);
    tests.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return tests;
  }

  /**
   * Shortest traceability path between two nodes, treating edges as UNDIRECTED (traceability is
   * about connection, e.g. requirement -> test -> evidence, regardless of edge orientation).
   * Returns the ordered path or null if unreachable.
   */
  trace(fromId: string, toId: string, opts: { readonly maxDepth?: number } = {}): TraceStep[] | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    const maxDepth = opts.maxDepth ?? Infinity;
    if (fromId === toId) return [{ node: this.nodes.get(fromId)! }];
    const prev = new Map<string, { id: string; via: TraceStep["via"] }>();
    const depth = new Map<string, number>([[fromId, 0]]);
    const queue: string[] = [fromId];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      const d = depth.get(cur)!;
      if (d >= maxDepth) continue;
      const step = (nb: string, via: TraceStep["via"]) => {
        if (depth.has(nb)) return false;
        depth.set(nb, d + 1);
        prev.set(nb, { id: cur, via });
        queue.push(nb);
        return nb === toId;
      };
      let done = false;
      for (const e of this.out.get(cur) ?? []) if (step(e.to, { type: e.type, id: e.id, forward: true })) { done = true; break; }
      if (done) break;
      for (const e of this.in.get(cur) ?? []) if (step(e.from, { type: e.type, id: e.id, forward: false })) { done = true; break; }
      if (done) break;
    }
    if (!prev.has(toId)) return null;
    const chain: TraceStep[] = [];
    let cursor: string | undefined = toId;
    while (cursor !== undefined) {
      const p = prev.get(cursor);
      chain.push({ node: this.nodes.get(cursor)!, ...(p?.via ? { via: p.via } : {}) });
      cursor = p?.id;
    }
    chain.reverse();
    return chain;
  }

  /**
   * Root-cause correlation for a finding: the code/components it directly affects, then (ranked by
   * distance) what those affected nodes DEPEND ON — a defect frequently originates upstream of where
   * it surfaces. Returns candidates ordered nearest-first.
   */
  rootCause(findingId: string): RootCauseCandidate[] {
    const finding = this.nodes.get(findingId);
    if (!finding || finding.type !== NodeType.FINDING) throw new Error(`knowledge-graph: "${findingId}" is not a FINDING node`);
    const out: RootCauseCandidate[] = [];
    const seen = new Set<string>([findingId]);
    // Direct targets via AFFECTS.
    const direct: string[] = [];
    for (const e of this.out.get(findingId) ?? []) {
      if (e.type === EdgeType.AFFECTS && !seen.has(e.to)) {
        seen.add(e.to);
        direct.push(e.to);
        out.push({ node: this.nodes.get(e.to)!, distance: 1, relation: "directly affected" });
      }
    }
    // Upstream dependencies of the affected nodes (transitive DEPENDS_ON, forward = toward dependency).
    const queue = direct.map((id) => ({ id, dist: 1 }));
    for (let i = 0; i < queue.length; i++) {
      const { id, dist } = queue[i]!;
      for (const e of this.out.get(id) ?? []) {
        if (e.type === EdgeType.DEPENDS_ON && !seen.has(e.to)) {
          seen.add(e.to);
          out.push({ node: this.nodes.get(e.to)!, distance: dist + 1, relation: "upstream dependency of an affected node" });
          queue.push({ id: e.to, dist: dist + 1 });
        }
      }
    }
    out.sort((a, b) => a.distance - b.distance || (a.node.id < b.node.id ? -1 : 1));
    return out;
  }

  /**
   * The realized surface of a set of shipped nodes: the shipped nodes themselves, everything a
   * shipped container holds (forward CONTAINS/EXPOSES), and the code/features that implement a
   * shipped spec (backward IMPLEMENTS). Used to scope which findings block a release.
   */
  private shippedSurface(shippedIds: readonly string[]): Set<string> {
    const surface = new Set<string>(shippedIds);
    const queue = [...shippedIds];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      for (const e of this.out.get(cur) ?? []) {
        if ((e.type === EdgeType.CONTAINS || e.type === EdgeType.EXPOSES) && !surface.has(e.to)) {
          surface.add(e.to);
          queue.push(e.to);
        }
      }
      for (const e of this.in.get(cur) ?? []) {
        if (e.type === EdgeType.IMPLEMENTS && !surface.has(e.from)) {
          surface.add(e.from);
          queue.push(e.from);
        }
      }
    }
    return surface;
  }

  /** Forward reach over a specific set of edge types (used by release assurance). */
  private forwardReach(startIds: readonly string[], edgeTypes: ReadonlySet<EdgeType>, collectType?: NodeType): Set<string> {
    const found = new Set<string>();
    const visited = new Set<string>(startIds);
    const queue = [...startIds];
    for (let i = 0; i < queue.length; i++) {
      for (const e of this.out.get(queue[i]!) ?? []) {
        if (!edgeTypes.has(e.type)) continue;
        const target = this.nodes.get(e.to)!;
        if (collectType === undefined || target.type === collectType) found.add(e.to);
        if (!visited.has(e.to)) {
          visited.add(e.to);
          queue.push(e.to);
        }
      }
    }
    return found;
  }

  /**
   * Release assurance: is everything this release ships actually traceable to validated, passing
   * evidence and free of open findings? FAIL-CLOSED — a requirement with no validating test or no
   * passing evidence is a GAP; a shipped feature with no requirement is untraceable; any open
   * finding on the shipped surface blocks; an empty release is NOT_ASSURED.
   */
  releaseAssurance(releaseId: string): ReleaseAssuranceReport {
    const release = this.nodes.get(releaseId);
    if (!release || release.type !== NodeType.RELEASE) throw new Error(`knowledge-graph: "${releaseId}" is not a RELEASE node`);
    const reasons: string[] = [];

    const shippedIds: string[] = [];
    for (const e of this.out.get(releaseId) ?? []) if (e.type === EdgeType.SHIPS) shippedIds.push(e.to);
    const shipped = shippedIds.map((id) => {
      const n = this.nodes.get(id)!;
      return { id: n.id, type: n.type, key: n.key };
    });

    // Requirements reachable from the shipped artifacts via IMPLEMENTS (code->feature->requirement).
    const reqIds = this.forwardReach(shippedIds, new Set([EdgeType.IMPLEMENTS]), NodeType.REQUIREMENT);

    // Shipped features/flows that trace to NO requirement are untraceable gaps.
    const untraceableShipped: { id: string; type: NodeType; key: string }[] = [];
    for (const id of shippedIds) {
      const n = this.nodes.get(id)!;
      if (n.type !== NodeType.FEATURE && n.type !== NodeType.BUSINESS_FLOW) continue;
      const reqsOfThis = this.forwardReach([id], new Set([EdgeType.IMPLEMENTS]), NodeType.REQUIREMENT);
      if (reqsOfThis.size === 0) untraceableShipped.push({ id: n.id, type: n.type, key: n.key });
    }

    // Each requirement: validated by a test whose produced evidence passes?
    const requirements = [...reqIds]
      .map((rid) => this.nodes.get(rid)!)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((req) => {
        const validatingTests = (this.in.get(req.id) ?? []).filter((e) => e.type === EdgeType.VALIDATES).map((e) => e.from);
        const validated = validatingTests.length > 0;
        let passingEvidence = false;
        for (const testId of validatingTests) {
          for (const e of this.out.get(testId) ?? []) {
            if (e.type === EdgeType.PRODUCES) {
              const ev = this.nodes.get(e.to)!;
              if (isPassingEvidence(ev)) {
                passingEvidence = true;
                break;
              }
            }
          }
          if (passingEvidence) break;
        }
        const status: "ASSURED" | "GAP" = validated && passingEvidence ? "ASSURED" : "GAP";
        return { id: req.id, key: req.key, validated, passingEvidence, status };
      });

    // Blocking findings: open findings affecting the shipped surface. The surface is the shipped
    // nodes PLUS the code/components/apis that realize them — reached forward through CONTAINS/EXPOSES
    // (what a shipped service holds) and BACKWARD through IMPLEMENTS (the code that implements a
    // shipped feature). A defect in the code behind a shipped feature must block the release.
    const surface = this.shippedSurface(shippedIds);
    const blockingFindings: ReleaseAssuranceReport["blockingFindings"][number][] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== NodeType.FINDING) continue;
      const status = String((node.attrs as Record<string, unknown> | undefined)?.status ?? "");
      if (!OPEN_FINDING_STATUSES.has(status)) continue;
      const affects = (this.out.get(node.id) ?? [])
        .filter((e) => e.type === EdgeType.AFFECTS && surface.has(e.to))
        .map((e) => this.nodes.get(e.to)!.key);
      if (affects.length > 0) {
        blockingFindings.push({
          id: node.id,
          key: node.key,
          status,
          severity: (node.attrs as Record<string, unknown> | undefined)?.severity as string | undefined,
          affects: affects.sort(),
        });
      }
    }
    blockingFindings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // Verdict — fail closed.
    if (shipped.length === 0) reasons.push("release ships nothing (cannot be assured)");
    const gaps = requirements.filter((r) => r.status === "GAP");
    if (gaps.length > 0) reasons.push(`${gaps.length} requirement(s) without validated passing evidence`);
    if (untraceableShipped.length > 0) reasons.push(`${untraceableShipped.length} shipped feature(s) not traceable to a requirement`);
    if (blockingFindings.length > 0) reasons.push(`${blockingFindings.length} open finding(s) on the shipped surface`);
    const verdict: "ASSURED" | "NOT_ASSURED" =
      shipped.length > 0 && gaps.length === 0 && untraceableShipped.length === 0 && blockingFindings.length === 0 ? "ASSURED" : "NOT_ASSURED";
    if (verdict === "ASSURED") reasons.push("all shipped artifacts traceable to validated passing evidence; no open findings");

    return { releaseId: release.id, releaseKey: release.key, shipped, requirements, untraceableShipped, blockingFindings, verdict, reasons };
  }

  /** Serialize to a plain, deterministically-ordered document (stable for hashing/provenance). */
  toJSON(): GraphDocument {
    const nodes = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const edges = [...this.edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return { nodes, edges };
  }
}
