import { describe, it, expect } from "vitest";
import { KnowledgeGraph, NodeType, EdgeType, EDGE_TYPES, graphFromDocument } from "@uaap/knowledge-graph";

/**
 * Build a realistic assurance graph:
 *   REQ-1  <-IMPLEMENTS- F-checkout <-IMPLEMENTS- code/checkout.ts
 *   svc-orders CONTAINS comp-cart CONTAINS code/checkout.ts
 *   svc-orders DEPENDS_ON svc-payments
 *   svc-orders EXPOSES /checkout ; PERSISTS_TO db-orders ; EMITS evt-order-placed
 *   svc-notifications CONSUMES evt-order-placed
 *   code/checkout.ts DEPENDS_ON code/pricing.ts
 *   test-checkout COVERS code/checkout.ts ; VALIDATES REQ-1 ; PRODUCES ev-pass (PASS)
 *   test-payments COVERS svc-payments
 *   find-1 AFFECTS code/checkout.ts (CONFIRMED = open)
 *   rel-1 SHIPS F-checkout
 */
function build() {
  const g = new KnowledgeGraph();
  const req1 = g.addNode({ type: NodeType.REQUIREMENT, key: "REQ-1" });
  const feat = g.addNode({ type: NodeType.FEATURE, key: "F-checkout" });
  const code = g.addNode({ type: NodeType.CODE, key: "code/checkout.ts" });
  const pricing = g.addNode({ type: NodeType.CODE, key: "code/pricing.ts" });
  const comp = g.addNode({ type: NodeType.COMPONENT, key: "comp-cart" });
  const svcOrders = g.addNode({ type: NodeType.SERVICE, key: "svc-orders" });
  const svcPay = g.addNode({ type: NodeType.SERVICE, key: "svc-payments" });
  const svcNotif = g.addNode({ type: NodeType.SERVICE, key: "svc-notifications" });
  const api = g.addNode({ type: NodeType.API, key: "/checkout" });
  const db = g.addNode({ type: NodeType.DATABASE, key: "db-orders" });
  const evt = g.addNode({ type: NodeType.EVENT, key: "evt-order-placed" });
  const testCk = g.addNode({ type: NodeType.TEST, key: "test-checkout" });
  const testPay = g.addNode({ type: NodeType.TEST, key: "test-payments" });
  const evPass = g.addNode({ type: NodeType.EVIDENCE, key: "ev-pass", attrs: { outcome: "PASS" } });
  const find1 = g.addNode({ type: NodeType.FINDING, key: "find-1", attrs: { status: "CONFIRMED", severity: "P1" } });
  const rel1 = g.addNode({ type: NodeType.RELEASE, key: "rel-1" });

  g.addEdge(EdgeType.IMPLEMENTS, feat, req1);
  g.addEdge(EdgeType.IMPLEMENTS, code, feat);
  g.addEdge(EdgeType.CONTAINS, comp, code);
  g.addEdge(EdgeType.CONTAINS, svcOrders, comp);
  g.addEdge(EdgeType.DEPENDS_ON, svcOrders, svcPay);
  g.addEdge(EdgeType.DEPENDS_ON, code, pricing);
  g.addEdge(EdgeType.EXPOSES, svcOrders, api);
  g.addEdge(EdgeType.PERSISTS_TO, svcOrders, db);
  g.addEdge(EdgeType.EMITS, svcOrders, evt);
  g.addEdge(EdgeType.CONSUMES, svcNotif, evt);
  g.addEdge(EdgeType.COVERS, testCk, code);
  g.addEdge(EdgeType.VALIDATES, testCk, req1);
  g.addEdge(EdgeType.PRODUCES, testCk, evPass);
  g.addEdge(EdgeType.COVERS, testPay, svcPay);
  g.addEdge(EdgeType.AFFECTS, find1, code);
  g.addEdge(EdgeType.SHIPS, rel1, feat);

  return { g, ids: { req1, feat, code, pricing, comp, svcOrders, svcPay, svcNotif, api, db, evt, testCk, testPay, evPass, find1, rel1 } };
}

describe("KnowledgeGraph — construction & integrity", () => {
  it("is content-addressed and idempotent per (type,key)", () => {
    const g = new KnowledgeGraph();
    const a = g.addNode({ type: NodeType.SERVICE, key: "svc" });
    const b = g.addNode({ type: NodeType.SERVICE, key: "svc", attrs: { env: "prod" } });
    expect(a).toBe(b);
    expect(g.nodeCount()).toBe(1);
    expect(g.getNode(a)?.attrs?.env).toBe("prod"); // attrs merged on re-add
    const c = g.addNode({ type: NodeType.CODE, key: "svc" }); // same key, different type => different node
    expect(c).not.toBe(a);
    expect(g.nodeCount()).toBe(2);
  });

  it("deduplicates identical edges", () => {
    const g = new KnowledgeGraph();
    const s = g.addNode({ type: NodeType.SERVICE, key: "s" });
    const a = g.addNode({ type: NodeType.API, key: "a" });
    const e1 = g.addEdge(EdgeType.EXPOSES, s, a);
    const e2 = g.addEdge(EdgeType.EXPOSES, s, a);
    expect(e1).toBe(e2);
    expect(g.edgeCount()).toBe(1);
  });

  it("FAIL-CLOSED: rejects illegal endpoint types and missing nodes", () => {
    const g = new KnowledgeGraph();
    const req = g.addNode({ type: NodeType.REQUIREMENT, key: "R" });
    const code = g.addNode({ type: NodeType.CODE, key: "c" });
    // COVERS must originate from a TEST, not a REQUIREMENT
    expect(() => g.addEdge(EdgeType.COVERS, req, code)).toThrow(/COVERS source must be/);
    // endpoint must exist
    expect(() => g.addEdge(EdgeType.IMPLEMENTS, code, "N_does_not_exist")).toThrow(/missing target node/);
    expect(() => g.addNode({ type: NodeType.CODE, key: "" })).toThrow(/non-empty/);
  });
});

describe("KnowledgeGraph — impact direction is semantic, not guessed", () => {
  it("DEPENDS_ON propagates to the dependent, NOT to the dependency", () => {
    const { g, ids } = build();
    const fromOrders = g.changeImpact([ids.svcOrders]).impacted.map((i) => i.node.key);
    expect(fromOrders).not.toContain("svc-payments"); // changing orders does not impact its dependency
    const fromPay = g.changeImpact([ids.svcPay]).impacted.map((i) => i.node.key);
    expect(fromPay).toContain("svc-orders"); // changing the dependency DOES impact the dependent
  });

  it("change-impact of code reaches features, tests, evidence, container and event consumers", () => {
    const { g, ids } = build();
    const keys = g.blastRadius([ids.code]).impacted.map((i) => i.node.key);
    for (const k of ["F-checkout", "REQ-1", "test-checkout", "ev-pass", "comp-cart", "svc-orders", "/checkout", "evt-order-placed", "svc-notifications", "find-1"]) {
      expect(keys, k).toContain(k);
    }
    // a pure dependency (payments) and the datastore are NOT impacted by a checkout-code change
    expect(keys).not.toContain("svc-payments");
    expect(keys).not.toContain("db-orders");
  });

  it("respects maxDepth (blast radius is bounded when asked)", () => {
    const { g, ids } = build();
    const d1 = g.changeImpact([ids.code], { maxDepth: 1 }).impacted.map((i) => i.node.key);
    expect(d1).toContain("F-checkout"); // depth 1
    expect(d1).not.toContain("REQ-1"); // depth 2 — excluded at maxDepth 1
  });
});

describe("KnowledgeGraph — regression selection", () => {
  it("selects only the tests whose coverage is in the change's blast radius", () => {
    const { g, ids } = build();
    const forCode = g.regressionSelection([ids.code]).map((t) => t.key);
    expect(forCode).toEqual(["test-checkout"]); // test-payments is unrelated to a checkout-code change
    const forPay = g.regressionSelection([ids.svcPay]).map((t) => t.key);
    expect(forPay).toContain("test-payments");
    expect(forPay).toContain("test-checkout"); // payments is a dependency of orders -> checkout
  });
});

describe("KnowledgeGraph — traceability & root cause", () => {
  it("traces a path from a requirement to its evidence", () => {
    const { g, ids } = build();
    const path = g.trace(ids.req1, ids.evPass);
    expect(path).not.toBeNull();
    expect(path![0]!.node.key).toBe("REQ-1");
    expect(path![path!.length - 1]!.node.key).toBe("ev-pass");
    expect(g.trace(ids.req1, ids.req1)!.length).toBe(1); // self
  });

  it("returns null for an unreachable pair", () => {
    const g = new KnowledgeGraph();
    const a = g.addNode({ type: NodeType.SERVICE, key: "a" });
    const b = g.addNode({ type: NodeType.SERVICE, key: "b" });
    expect(g.trace(a, b)).toBeNull();
  });

  it("root-cause lists the directly affected code then its upstream dependencies", () => {
    const { g, ids } = build();
    const rc = g.rootCause(ids.find1);
    expect(rc[0]!.node.key).toBe("code/checkout.ts");
    expect(rc[0]!.distance).toBe(1);
    const pricing = rc.find((c) => c.node.key === "code/pricing.ts");
    expect(pricing?.distance).toBe(2); // upstream dependency of the affected code
    expect(() => g.rootCause(ids.req1)).toThrow(/not a FINDING/);
  });
});

describe("KnowledgeGraph — release assurance (fail closed)", () => {
  it("NOT_ASSURED when an open finding affects the shipped surface", () => {
    const { g, ids } = build(); // find-1 is CONFIRMED (open) and affects shipped feature's code
    const r = g.releaseAssurance(ids.rel1);
    expect(r.verdict).toBe("NOT_ASSURED");
    expect(r.blockingFindings.map((f) => f.key)).toContain("find-1");
    expect(r.requirements.find((x) => x.key === "REQ-1")?.status).toBe("ASSURED"); // the requirement itself is fine
  });

  it("ASSURED once the finding is closed and the requirement has passing evidence", () => {
    const { g, ids } = build();
    g.addNode({ type: NodeType.FINDING, key: "find-1", attrs: { status: "CLOSED" } }); // upsert -> closed
    const r = g.releaseAssurance(ids.rel1);
    expect(r.blockingFindings).toHaveLength(0);
    expect(r.verdict).toBe("ASSURED");
    expect(r.reasons.some((x) => /traceable to validated passing evidence/.test(x))).toBe(true);
  });

  it("GAP when a shipped requirement has no passing evidence", () => {
    const { g, ids } = build();
    g.addNode({ type: NodeType.FINDING, key: "find-1", attrs: { status: "CLOSED" } });
    // ship a second feature whose requirement is validated but whose evidence FAILS
    const req2 = g.addNode({ type: NodeType.REQUIREMENT, key: "REQ-2" });
    const feat2 = g.addNode({ type: NodeType.FEATURE, key: "F-refunds" });
    const t2 = g.addNode({ type: NodeType.TEST, key: "test-refunds" });
    const evFail = g.addNode({ type: NodeType.EVIDENCE, key: "ev-fail", attrs: { outcome: "FAIL" } });
    g.addEdge(EdgeType.IMPLEMENTS, feat2, req2);
    g.addEdge(EdgeType.VALIDATES, t2, req2);
    g.addEdge(EdgeType.PRODUCES, t2, evFail);
    g.addEdge(EdgeType.SHIPS, ids.rel1, feat2);
    const r = g.releaseAssurance(ids.rel1);
    expect(r.verdict).toBe("NOT_ASSURED");
    const gap = r.requirements.find((x) => x.key === "REQ-2");
    expect(gap?.validated).toBe(true);
    expect(gap?.passingEvidence).toBe(false);
    expect(gap?.status).toBe("GAP");
  });

  it("flags a shipped feature that traces to NO requirement", () => {
    const { g, ids } = build();
    g.addNode({ type: NodeType.FINDING, key: "find-1", attrs: { status: "CLOSED" } });
    const orphan = g.addNode({ type: NodeType.FEATURE, key: "F-orphan" });
    g.addEdge(EdgeType.SHIPS, ids.rel1, orphan);
    const r = g.releaseAssurance(ids.rel1);
    expect(r.verdict).toBe("NOT_ASSURED");
    expect(r.untraceableShipped.map((s) => s.key)).toContain("F-orphan");
  });

  it("an empty release can never be ASSURED", () => {
    const g = new KnowledgeGraph();
    const rel = g.addNode({ type: NodeType.RELEASE, key: "rel-empty" });
    const r = g.releaseAssurance(rel);
    expect(r.verdict).toBe("NOT_ASSURED");
    expect(r.reasons.some((x) => /ships nothing/.test(x))).toBe(true);
    expect(() => g.releaseAssurance(g.addNode({ type: NodeType.CODE, key: "x" }))).toThrow(/not a RELEASE/);
  });
});

// A release that ships a FEATURE which is fully traceable (code -> feature -> requirement),
// validated by a test with passing evidence. Optionally attaches a finding to the code so the
// verdict depends ONLY on the finding's status.
function assuredBase(findingAttrs?: Record<string, unknown>) {
  const g = new KnowledgeGraph();
  const rel = g.addNode({ type: NodeType.RELEASE, key: "r" });
  const feat = g.addNode({ type: NodeType.FEATURE, key: "f" });
  const code = g.addNode({ type: NodeType.CODE, key: "c" });
  const req = g.addNode({ type: NodeType.REQUIREMENT, key: "rq" });
  const test = g.addNode({ type: NodeType.TEST, key: "t" });
  const ev = g.addNode({ type: NodeType.EVIDENCE, key: "e", attrs: { outcome: "PASS" } });
  g.addEdge(EdgeType.SHIPS, rel, feat);
  g.addEdge(EdgeType.IMPLEMENTS, code, feat);
  g.addEdge(EdgeType.IMPLEMENTS, feat, req);
  g.addEdge(EdgeType.VALIDATES, test, req);
  g.addEdge(EdgeType.PRODUCES, test, ev);
  if (findingAttrs) {
    const fd = g.addNode({ type: NodeType.FINDING, key: "fd", attrs: findingAttrs });
    g.addEdge(EdgeType.AFFECTS, fd, code);
  }
  return { g, rel };
}

describe("KnowledgeGraph — review regressions (PR #10, confirmed findings)", () => {
  it("P0: a release that ships a bare SERVICE/CODE/COMPONENT is NOT_ASSURED (no fake pass)", () => {
    for (const t of [NodeType.SERVICE, NodeType.CODE, NodeType.COMPONENT]) {
      const g = new KnowledgeGraph();
      const rel = g.addNode({ type: NodeType.RELEASE, key: "rel" });
      const node = g.addNode({ type: t, key: `bare-${t}` });
      g.addEdge(EdgeType.SHIPS, rel, node);
      const r = g.releaseAssurance(rel);
      expect(r.verdict, t).toBe("NOT_ASSURED");
      expect(r.untraceableShipped.map((s) => s.key), t).toContain(`bare-${t}`);
    }
  });

  it("P0: requirements behind a shipped SERVICE (via CONTAINS) are discovered and gated", () => {
    // svc CONTAINS code IMPLEMENTS feat IMPLEMENTS req — req has NO passing evidence => GAP.
    const g = new KnowledgeGraph();
    const rel = g.addNode({ type: NodeType.RELEASE, key: "rel" });
    const svc = g.addNode({ type: NodeType.SERVICE, key: "svc" });
    const code = g.addNode({ type: NodeType.CODE, key: "c" });
    const feat = g.addNode({ type: NodeType.FEATURE, key: "f" });
    const req = g.addNode({ type: NodeType.REQUIREMENT, key: "rq" });
    g.addEdge(EdgeType.SHIPS, rel, svc);
    g.addEdge(EdgeType.CONTAINS, svc, code);
    g.addEdge(EdgeType.IMPLEMENTS, code, feat);
    g.addEdge(EdgeType.IMPLEMENTS, feat, req);
    const r = g.releaseAssurance(rel);
    expect(r.verdict).toBe("NOT_ASSURED");
    expect(r.requirements.map((x) => x.key)).toContain("rq"); // discovered through the container
    expect(r.requirements.find((x) => x.key === "rq")?.status).toBe("GAP");
  });

  it("P0: a shipped SERVICE fully traceable + validated + passing evidence is ASSURED", () => {
    const g = new KnowledgeGraph();
    const rel = g.addNode({ type: NodeType.RELEASE, key: "rel" });
    const svc = g.addNode({ type: NodeType.SERVICE, key: "svc" });
    const code = g.addNode({ type: NodeType.CODE, key: "c" });
    const feat = g.addNode({ type: NodeType.FEATURE, key: "f" });
    const req = g.addNode({ type: NodeType.REQUIREMENT, key: "rq" });
    const test = g.addNode({ type: NodeType.TEST, key: "t" });
    const ev = g.addNode({ type: NodeType.EVIDENCE, key: "e", attrs: { outcome: "PASS" } });
    g.addEdge(EdgeType.SHIPS, rel, svc);
    g.addEdge(EdgeType.CONTAINS, svc, code);
    g.addEdge(EdgeType.IMPLEMENTS, code, feat);
    g.addEdge(EdgeType.IMPLEMENTS, feat, req);
    g.addEdge(EdgeType.VALIDATES, test, req);
    g.addEdge(EdgeType.PRODUCES, test, ev);
    expect(g.releaseAssurance(rel).verdict).toBe("ASSURED");
  });

  it("sanity: the assuredBase fixture with no finding is ASSURED", () => {
    const { g, rel } = assuredBase();
    expect(g.releaseAssurance(rel).verdict).toBe("ASSURED");
  });

  it("P1: an open finding blocks even with non-canonical case ('confirmed')", () => {
    const { g, rel } = assuredBase({ status: "confirmed", severity: "P1" });
    const r = g.releaseAssurance(rel);
    expect(r.verdict).toBe("NOT_ASSURED");
    expect(r.blockingFindings.map((f) => f.key)).toContain("fd");
  });

  it("P2: an UNKNOWN or MISSING finding status blocks (fail-closed allow-list)", () => {
    expect(g2(assuredBase({ status: "WeIrD-STATE" })).verdict).toBe("NOT_ASSURED"); // unknown
    expect(g2(assuredBase({ severity: "P2" })).verdict).toBe("NOT_ASSURED"); // missing status
  });

  it("only terminal statuses (CLOSED / REJECTED_FALSE_POSITIVE, any case) do not block", () => {
    expect(g2(assuredBase({ status: "closed" })).verdict).toBe("ASSURED");
    expect(g2(assuredBase({ status: "REJECTED_FALSE_POSITIVE" })).verdict).toBe("ASSURED");
  });

  it("P2: a finding on a shipped SERVICE's DATABASE blocks (database is in the shipped surface)", () => {
    const g = new KnowledgeGraph();
    const rel = g.addNode({ type: NodeType.RELEASE, key: "rel" });
    const svc = g.addNode({ type: NodeType.SERVICE, key: "svc" });
    const code = g.addNode({ type: NodeType.CODE, key: "c" });
    const feat = g.addNode({ type: NodeType.FEATURE, key: "f" });
    const req = g.addNode({ type: NodeType.REQUIREMENT, key: "rq" });
    const test = g.addNode({ type: NodeType.TEST, key: "t" });
    const ev = g.addNode({ type: NodeType.EVIDENCE, key: "e", attrs: { outcome: "PASS" } });
    const db = g.addNode({ type: NodeType.DATABASE, key: "db" });
    const fd = g.addNode({ type: NodeType.FINDING, key: "fd", attrs: { status: "CONFIRMED" } });
    g.addEdge(EdgeType.SHIPS, rel, svc);
    g.addEdge(EdgeType.CONTAINS, svc, code);
    g.addEdge(EdgeType.IMPLEMENTS, code, feat);
    g.addEdge(EdgeType.IMPLEMENTS, feat, req);
    g.addEdge(EdgeType.VALIDATES, test, req);
    g.addEdge(EdgeType.PRODUCES, test, ev);
    g.addEdge(EdgeType.PERSISTS_TO, svc, db);
    g.addEdge(EdgeType.AFFECTS, fd, db);
    const r = g.releaseAssurance(rel);
    expect(r.verdict).toBe("NOT_ASSURED");
    expect(r.blockingFindings.map((f) => f.key)).toContain("fd");
  });

  it("P1: graphFromDocument rejects a document with a duplicate node id (fail-closed on ambiguity)", () => {
    const doc = {
      nodes: [
        { id: "dup", type: "SERVICE", key: "a" },
        { id: "dup", type: "CODE", key: "b" },
      ],
      edges: [],
    };
    expect(() => graphFromDocument(doc)).toThrow(/duplicate node id/);
  });

  it("P3: prototype property names are rejected as node/edge types (no fail-open)", () => {
    const g = new KnowledgeGraph();
    for (const bogus of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(() => g.addNode({ type: bogus as unknown as NodeType, key: "k" }), bogus).toThrow(/unknown node type/);
    }
    const a = g.addNode({ type: NodeType.SERVICE, key: "a" });
    const b = g.addNode({ type: NodeType.API, key: "b" });
    for (const bogus of ["constructor", "toString", "valueOf"]) {
      expect(() => g.addEdge(bogus as unknown as EdgeType, a, b), bogus).toThrow(/unknown edge type/);
    }
  });
});

// helper: run releaseAssurance on an assuredBase({...}) result
function g2(base: { g: KnowledgeGraph; rel: string }) {
  return base.g.releaseAssurance(base.rel);
}

describe("KnowledgeGraph — serialization & schema-validated load", () => {
  it("round-trips through a schema-validated document and preserves queries", () => {
    const { g, ids } = build();
    const doc = g.toJSON();
    expect(doc.nodes.length).toBe(g.nodeCount());
    expect(doc.edges.length).toBe(g.edgeCount());
    const g2 = graphFromDocument(doc);
    expect(g2.nodeCount()).toBe(g.nodeCount());
    expect(g2.edgeCount()).toBe(g.edgeCount());
    // ids are content-addressed, so the same facts produce the same ids after a reload
    expect(g2.resolve(NodeType.CODE, "code/checkout.ts")).toBe(ids.code);
    expect(g2.regressionSelection([ids.code]).map((t) => t.key)).toEqual(["test-checkout"]);
  });

  it("rejects a structurally malformed document", () => {
    expect(() => graphFromDocument({ nodes: [{ id: "x", type: "NOT_A_TYPE", key: "k" }], edges: [] })).toThrow(/schema validation/);
    expect(() => graphFromDocument({ nodes: [] })).toThrow(/schema validation/);
  });

  it("rejects a schema-valid document with an ILLEGAL relationship (defense in depth)", () => {
    // Shape is valid JSON-schema-wise, but COVERS from a REQUIREMENT violates the engine contract.
    const doc = {
      nodes: [
        { id: "r", type: "REQUIREMENT", key: "R" },
        { id: "c", type: "CODE", key: "c" },
      ],
      edges: [{ id: "e", type: "COVERS", from: "r", to: "c" }],
    };
    expect(() => graphFromDocument(doc)).toThrow(/COVERS source must be/);
  });

  it("the edge contract covers every EdgeType with a declared impact direction", () => {
    for (const t of Object.values(EdgeType)) {
      expect(EDGE_TYPES[t], t).toBeDefined();
      expect(["forward", "backward", "both", "none"]).toContain(EDGE_TYPES[t].propagatesImpact);
    }
  });
});
