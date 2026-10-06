// Shared views assertion. Drives the rendered app in `win` and checks each view reflects the
// COMPUTED real view-model values, using CARD-SCOPED DOM reads (textContent — layout-independent on
// an offscreen window) and ground-truth anchors (agents total ===72, a known knowledge node id must
// render, the security State card === the real posture). Used by the dev views-smoke AND the
// packaged-app startup smoke (main.js UAAP_SMOKE mode). Returns { ok, checks, ... }. Fabricates
// nothing: `expected` is collectState() computed on the main side.
"use strict";

async function assertViews(win, expected) {
  const vm = expected && expected.viewModels;
  if (!vm) return { ok: false, checks: {}, reason: "view-model bundle not built" };
  const js = (code) => win.webContents.executeJavaScript(code);

  // Wait for boot() to render the home view.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const r = await js("(function(){var m=document.querySelector('#main .title');return m?1:0;})()").catch(() => 0);
    if (r) { ready = true; break; }
    await new Promise((res) => setTimeout(res, 100));
  }
  if (!ready) return { ok: false, checks: {}, reason: "renderer did not render within timeout" };

  const read = async (view) => {
    await js("show(" + JSON.stringify(view) + ");");
    return String(await js("document.getElementById('main').textContent"));
  };
  const cardVal = (label) => js(
    "(function(){var cs=[].slice.call(document.querySelectorAll('#main .card'));" +
    "for(var i=0;i<cs.length;i++){var k=cs[i].querySelector('.k');" +
    "if(k&&k.textContent.trim()===" + JSON.stringify(label) + "){var v=cs[i].querySelector('.v');return v?v.textContent.trim():null;}}return null;})()"
  ).then((x) => (x === null ? null : String(x)));

  await read("home");
  const homeDoneCard = await cardVal("Build graph");
  const homeSecCard = await cardVal("Active security validation");
  await read("agents");
  const agentsTotalCard = await cardVal("Defined roles");
  const agentsCertCard = await cardVal("Certified");
  const secTxt = await read("security");
  const secStateCard = await cardVal("State");
  const knowTxt = await read("knowledge");
  const knowNodesCard = await cardVal("Knowledge nodes");
  await read("learning");
  const learnCertCard = await cardVal("Agents certified");

  const knownKnowledgeId = (expected.knowledge.nodes.find((n) => n.id === "knowledge-store") || expected.knowledge.nodes[0] || {}).id || "";

  const checks = {
    homeDoneTotal: homeDoneCard === vm.home.nodes.done + "/" + vm.home.nodes.total + " done",
    homeSecurity: homeSecCard === vm.home.activeSecurityValidation,
    agentsRealTotal: vm.agents.total === 72 && agentsTotalCard === String(vm.agents.total),
    agentsCertified: agentsCertCard === String(vm.agents.certified),
    securityLocked: vm.securityPosture.locked === true && secTxt.includes("LOCKED") && secStateCard === vm.securityPosture.activeValidation,
    knowledgeRendered: expected.knowledge.nodes.length > 0 && knowNodesCard === String(expected.knowledge.nodes.length) && !!knownKnowledgeId && knowTxt.includes(knownKnowledgeId),
    learningRendered: learnCertCard === expected.learning.certified + " / " + expected.learning.defined,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    agentsTotal: vm.agents.total,
    securityLocked: vm.securityPosture.locked,
    homeDone: vm.home.nodes.done,
    homeTotal: vm.home.nodes.total,
  };
}

module.exports = { assertViews };
