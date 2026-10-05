// Node and edge vocabulary for the assurance knowledge graph, plus — the important part —
// the per-edge-type IMPACT PROPAGATION direction. Change-impact / blast-radius / regression
// selection are only meaningful if each relationship declares how a change at one end reaches
// the other. "forward" = a change at `from` affects `to`; "backward" = a change at `to` affects
// `from`; "both" = either end affects the other; "none" = structural link, no change propagation.

/** Entity kinds the graph links. Mirrors the digital-twin fact kinds plus code/queue granularity. */
export const NodeType = {
  REQUIREMENT: "REQUIREMENT",
  FEATURE: "FEATURE",
  BUSINESS_FLOW: "BUSINESS_FLOW",
  CODE: "CODE",
  COMPONENT: "COMPONENT",
  SERVICE: "SERVICE",
  API: "API",
  DATABASE: "DATABASE",
  EVENT: "EVENT",
  QUEUE: "QUEUE",
  TEST: "TEST",
  FINDING: "FINDING",
  EVIDENCE: "EVIDENCE",
  RISK: "RISK",
  RELEASE: "RELEASE",
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const EdgeType = {
  /** implementer realizes a spec: Code IMPLEMENTS Feature, Feature IMPLEMENTS Requirement. */
  IMPLEMENTS: "IMPLEMENTS",
  /** container holds a child: Service CONTAINS Component, Component CONTAINS Code. */
  CONTAINS: "CONTAINS",
  /** dependent needs a dependency (classic build/runtime dependency). */
  DEPENDS_ON: "DEPENDS_ON",
  /** service/component publishes an API surface. */
  EXPOSES: "EXPOSES",
  /** service/api reads+writes a datastore. */
  PERSISTS_TO: "PERSISTS_TO",
  /** service/api publishes to an event/queue. */
  EMITS: "EMITS",
  /** service/api consumes from an event/queue. */
  CONSUMES: "CONSUMES",
  /** a test exercises a target (code/api/feature/component/service/flow). */
  COVERS: "COVERS",
  /** a test validates a requirement. */
  VALIDATES: "VALIDATES",
  /** a test run produces evidence. */
  PRODUCES: "PRODUCES",
  /** a finding is located in / affects a target. */
  AFFECTS: "AFFECTS",
  /** evidence supports a finding / a requirement's validation / a test result. */
  SUPPORTS: "SUPPORTS",
  /** a risk threatens a target. */
  THREATENS: "THREATENS",
  /** a release ships features/code/services. */
  SHIPS: "SHIPS",
} as const;
export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];

export type ImpactDirection = "forward" | "backward" | "both" | "none";

export interface EdgeTypeDescriptor {
  /** Allowed source node types (empty = any). */
  readonly from: readonly NodeType[];
  /** Allowed destination node types (empty = any). */
  readonly to: readonly NodeType[];
  /** How a CHANGE propagates across this edge (drives impact/blast-radius/regression). */
  readonly propagatesImpact: ImpactDirection;
}

/**
 * The edge contract. Endpoint-type constraints are enforced on insert (a COVERS edge must go
 * from a TEST, etc.) so the graph cannot be populated with nonsense relationships, and the
 * impact direction is consulted by the traversal engine — never guessed.
 */
export const EDGE_TYPES: Readonly<Record<EdgeType, EdgeTypeDescriptor>> = {
  IMPLEMENTS: {
    from: [NodeType.CODE, NodeType.FEATURE, NodeType.BUSINESS_FLOW],
    to: [NodeType.FEATURE, NodeType.REQUIREMENT],
    propagatesImpact: "both",
  },
  CONTAINS: {
    from: [NodeType.SERVICE, NodeType.COMPONENT],
    to: [NodeType.COMPONENT, NodeType.CODE, NodeType.API],
    propagatesImpact: "both",
  },
  DEPENDS_ON: {
    from: [NodeType.SERVICE, NodeType.COMPONENT, NodeType.CODE, NodeType.API],
    to: [NodeType.SERVICE, NodeType.COMPONENT, NodeType.CODE, NodeType.API],
    propagatesImpact: "backward", // a dependency changing impacts the dependent, not vice-versa
  },
  EXPOSES: {
    from: [NodeType.SERVICE, NodeType.COMPONENT],
    to: [NodeType.API],
    propagatesImpact: "both",
  },
  PERSISTS_TO: {
    from: [NodeType.SERVICE, NodeType.API, NodeType.COMPONENT],
    to: [NodeType.DATABASE],
    propagatesImpact: "backward", // schema/datastore change impacts its consumers
  },
  EMITS: {
    from: [NodeType.SERVICE, NodeType.API, NodeType.COMPONENT],
    to: [NodeType.EVENT, NodeType.QUEUE],
    propagatesImpact: "both", // emitter change alters payload; contract change impacts emitter
  },
  CONSUMES: {
    from: [NodeType.SERVICE, NodeType.API, NodeType.COMPONENT],
    to: [NodeType.EVENT, NodeType.QUEUE],
    propagatesImpact: "backward", // event/queue contract change impacts the consumer
  },
  COVERS: {
    from: [NodeType.TEST],
    to: [NodeType.CODE, NodeType.API, NodeType.FEATURE, NodeType.COMPONENT, NodeType.SERVICE, NodeType.BUSINESS_FLOW],
    propagatesImpact: "backward", // the covered target changing means the test must re-run
  },
  VALIDATES: {
    from: [NodeType.TEST],
    to: [NodeType.REQUIREMENT],
    propagatesImpact: "backward", // requirement change means its validating test must re-run
  },
  PRODUCES: {
    from: [NodeType.TEST],
    to: [NodeType.EVIDENCE],
    propagatesImpact: "forward", // a test re-running makes its prior evidence stale
  },
  AFFECTS: {
    from: [NodeType.FINDING],
    to: [NodeType.CODE, NodeType.API, NodeType.COMPONENT, NodeType.SERVICE, NodeType.DATABASE, NodeType.FEATURE],
    propagatesImpact: "backward", // the affected target changing can resolve/invalidate the finding
  },
  SUPPORTS: {
    from: [NodeType.EVIDENCE],
    to: [NodeType.FINDING, NodeType.REQUIREMENT, NodeType.TEST],
    propagatesImpact: "both",
  },
  THREATENS: {
    from: [NodeType.RISK],
    to: [NodeType.COMPONENT, NodeType.SERVICE, NodeType.FEATURE, NodeType.REQUIREMENT, NodeType.API, NodeType.DATABASE],
    propagatesImpact: "backward",
  },
  SHIPS: {
    from: [NodeType.RELEASE],
    to: [NodeType.FEATURE, NodeType.CODE, NodeType.SERVICE, NodeType.COMPONENT],
    propagatesImpact: "backward", // a shipped artifact changing impacts the release scope
  },
};

export interface GraphNode {
  readonly id: string;
  readonly type: NodeType;
  /** Stable, human-meaningful key within a type (e.g. a service name, requirement code, file path). */
  readonly key: string;
  readonly label?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface GraphEdge {
  readonly id: string;
  readonly type: EdgeType;
  readonly from: string;
  readonly to: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface GraphDocument {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** Finding statuses that count as OPEN (still blocking) for release assurance. */
export const OPEN_FINDING_STATUSES: ReadonlySet<string> = new Set([
  "SIGNAL",
  "HYPOTHESIS",
  "VALIDATION_PENDING",
  "CONFIRMED",
  "REMEDIATION_IN_PROGRESS",
  "RETEST_PENDING",
  "REOPENED",
]);

/**
 * The ONLY finding statuses that do NOT block a release — the terminal, resolved states. Release
 * assurance uses this as a CLOSED allow-list (fail-closed): any status not in here, including an
 * unknown, misspelled, mis-cased or missing status, is treated as blocking. A detector/importer can
 * never hide an open defect by emitting a status the gate hasn't heard of. Compared case-insensitively.
 */
export const NON_BLOCKING_FINDING_STATUSES: ReadonlySet<string> = new Set([
  "CLOSED",
  "REJECTED_FALSE_POSITIVE",
]);
