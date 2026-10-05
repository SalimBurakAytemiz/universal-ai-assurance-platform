// @uaap/knowledge-graph — the assurance knowledge graph: one typed, directed graph linking
// Requirement <-> Feature <-> Code <-> Component <-> Service <-> API <-> Database/Event/Queue <->
// Test <-> Finding <-> Evidence <-> Risk <-> Release. It answers traceability, change impact,
// blast radius, regression selection, root-cause correlation and release assurance.
//
// Deterministic (content-addressed ids), fail-closed (illegal relationships rejected on insert;
// loading an untrusted document is schema-validated before it is trusted).
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { readRepoJson } from "@uaap/core";
import { KnowledgeGraph } from "./graph.js";
import type { GraphDocument } from "./types.js";

export * from "./types.js";
export * from "./graph.js";

/**
 * Build a KnowledgeGraph from a serialized document, validating it against the JSON schema FIRST
 * (fail-closed: a malformed document is rejected, never partially loaded) and then re-validating
 * every edge's endpoint types through the engine's own contract. Nodes are inserted before edges.
 */
export function graphFromDocument(doc: unknown, startDir = dirname(fileURLToPath(import.meta.url))): KnowledgeGraph {
  const schema = readRepoJson<object>("schemas/knowledge-graph.schema.json", startDir);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (!validate(doc)) {
    const msg = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
    throw new Error(`knowledge-graph: document failed schema validation: ${msg}`);
  }
  const d = doc as GraphDocument;
  const g = new KnowledgeGraph();
  const idByOriginal = new Map<string, string>();
  for (const n of d.nodes) {
    // Fail-closed on ambiguity: a document that declares the same node id twice is rejected, never
    // last-wins resolved (which would silently rebind edges to the wrong node and corrupt queries).
    if (idByOriginal.has(n.id)) throw new Error(`knowledge-graph: duplicate node id "${n.id}" in document`);
    const newNodeId = g.addNode({
      type: n.type,
      key: n.key,
      ...(n.label !== undefined ? { label: n.label } : {}),
      ...(n.attrs ? { attrs: n.attrs } : {}),
    });
    idByOriginal.set(n.id, newNodeId);
  }
  for (const e of d.edges) {
    const from = idByOriginal.get(e.from);
    const to = idByOriginal.get(e.to);
    if (!from || !to) throw new Error(`knowledge-graph: edge ${e.type} references a node not present in the document`);
    g.addEdge(e.type, from, to, e.attrs); // re-validates endpoint types via the engine contract
  }
  return g;
}
