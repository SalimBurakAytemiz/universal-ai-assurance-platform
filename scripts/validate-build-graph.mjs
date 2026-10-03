import { validateOrThrow } from "./_ajv.mjs";

const graph = validateOrThrow("build-graph", "schemas/build-graph.schema.json", ".ai/BUILD_GRAPH.json");
const ids = new Set();
for (const n of graph.nodes) {
  if (ids.has(n.id)) throw new Error(`build-graph: duplicate node id "${n.id}"`);
  ids.add(n.id);
}
for (const n of graph.nodes) {
  for (const d of n.dependencies) {
    if (!ids.has(d)) throw new Error(`build-graph: node "${n.id}" depends on unknown node "${d}"`);
  }
}
// cycle detection (DFS)
const color = new Map();
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
function visit(id, stack) {
  if (color.get(id) === "done") return;
  if (color.get(id) === "open") throw new Error(`build-graph: dependency cycle at "${id}" (${stack.join(" -> ")})`);
  color.set(id, "open");
  for (const d of byId.get(id).dependencies) visit(d, [...stack, d]);
  color.set(id, "done");
}
for (const n of graph.nodes) visit(n.id, [n.id]);

const by = (s) => graph.nodes.filter((n) => n.status === s).length;
console.log(
  `OK: build graph valid — ${graph.nodes.length} nodes ` +
    `(DONE ${by("DONE")}, READY ${by("READY")}, BLOCKED ${by("BLOCKED")}, NOT_STARTED ${by("NOT_STARTED")})`,
);
