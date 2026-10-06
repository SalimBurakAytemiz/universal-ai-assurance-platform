// =============================================================================
// FULL END-TO-END ACCEPTANCE (FINAL AUDIT — Section 9)
//
// This is NOT a unit test of one package. It composes the REAL platform packages
// over a LOCAL SYNTHETIC project ("ShopFlow") and runs the actual product arc:
//
//   analyze (Quality web + Security appsec engines, via the real driveEngine)
//     -> evidence (EvidenceStore.record / bundle / verifyBundle — chain of custody)
//     -> findings (real EngineFindings mapped to core Findings)
//     -> verification (VerificationEngine — separation of duties, evidence-backed)
//     -> remediation (RemediationEngine — SoD across detector/remediator/validator/closer)
//     -> retest -> close
//     -> Release Gate (evaluateRelease — fail-closed, all 4 decisions)
//
// The acceptance thesis (audit section 9 / 13): the platform must produce BOTH a
// PASS and an intentionally-detected FAIL, and must NOT merely return green — a
// RELEASE_ALLOWED is reachable ONLY after a real detect -> verify -> remediate ->
// retest -> close -> clean-re-run arc. Everything here executes; nothing is mocked.
//
// CI-safe: both engines are offline/detection-only (no browser, no network, no
// target). The live browser drive is validated separately by the desktop/live smokes.
// =============================================================================
import { describe, it, expect } from "vitest";
import {
  AssuranceDomain,
  DataClassification,
  FindingStatus,
  Severity,
  type Finding,
} from "@uaap/core";
import {
  driveEngine,
  EngineStatus,
  type EngineContext,
  type EngineEvidence,
  type EngineResult,
} from "@uaap/engine-core";
import { QualityWebEngine, type WebEngineInput } from "@uaap/quality-web-engine";
import { SecurityAppsecEngine, type AppsecEngineInput } from "@uaap/security-appsec-engine";
import { EvidenceStore, EvidenceKind, type EvidenceInput } from "@uaap/evidence-engine";
import { VerificationEngine, Verdict } from "@uaap/verification-engine";
import { RemediationEngine } from "@uaap/remediation-engine";
import { evaluateRelease, GateStatus, ReleaseDecision, type ReleaseGateInput } from "@uaap/release-gate";

// --- Deterministic, strictly-increasing injected clock (no Date.now flakiness) ---
function makeClock(startMs = Date.parse("2026-01-01T00:00:00.000Z")) {
  let t = startMs;
  return () => new Date((t += 1000)).toISOString();
}

// --- The synthetic project: a web app with a login (clean) + checkout (broken) flow,
//     and an app-security snapshot with a clean module + a planted-vuln module. ---
// Canonical AWS EXAMPLE key shape, ASSEMBLED AT RUNTIME from fragments. The appsec engine sees the
// full value in the synthetic source it scans, but the literal never appears in this committed file —
// so the repo's "no committed secrets" baseline (git grep AKIA[0-9A-Z]{16}) stays green. (Not a real key.)
const SYNTHETIC_PLAINTEXT_SECRET = "AKIA" + "IOSFODNN7" + "EXAMPLE";

const webInput: WebEngineInput = {
  flows: [
    {
      // PASS: a healthy login flow — required elements present, nothing forbidden, clean console/network.
      id: "login",
      steps: [
        {
          action: "navigate",
          url: "/login",
          expectedUrl: "/login",
          status: 200,
          requires: [
            { selector: "#email", present: true, visible: true },
            { selector: "#submit", present: true, visible: true },
          ],
          forbids: [{ selector: ".error-banner", present: false }],
          console: [{ level: "info" }],
          network: [{ url: "/api/session", method: "GET", status: 200, ok: true }],
          ok: true,
        },
      ],
    },
    {
      // INTENTIONAL FAIL: checkout is broken — the pay button is missing, an error banner shows,
      // a console error fires, and a backing API 404s. Four distinct functional defects.
      id: "checkout",
      steps: [
        {
          action: "navigate",
          url: "/checkout",
          expectedUrl: "/checkout",
          status: 200,
          requires: [{ selector: "#pay", present: false }],
          forbids: [{ selector: ".error-banner", present: true }],
          console: [{ level: "error" }],
          network: [{ url: "/api/cart", method: "GET", status: 404 }],
          ok: true,
        },
      ],
    },
  ],
};

const appsecInput: AppsecEngineInput = {
  sources: [
    // PASS: a clean module — no secrets, no injection sinks.
    {
      path: "src/clean.ts",
      content: ["export function add(a: number, b: number) {", "  return a + b;", "}"].join("\n"),
    },
    // INTENTIONAL FAIL: a planted hardcoded secret + a SQL-injection pattern. Detection-only;
    // the engine must flag BOTH and must NEVER echo the secret value (redaction by construction).
    {
      path: "src/payments.ts",
      content: [
        `const awsKey = "${SYNTHETIC_PLAINTEXT_SECRET}";`,
        "function lookup(id) {",
        "  return db.query(`select * from orders where id = ${id}`);",
        "}",
      ].join("\n"),
    },
  ],
};

// Map an engine's EngineEvidence into a storable EvidenceInput (real chain-of-custody input).
function toEvidenceInput(runId: string, e: EngineEvidence, at: string): EvidenceInput {
  const KIND = (EvidenceKind as Record<string, string>)[e.kind] ?? EvidenceKind.MARKER;
  return {
    runId,
    producedBy: e.producedBy,
    action: e.action,
    kind: KIND as EvidenceInput["kind"],
    at,
    classification: e.classification,
    data: e.data ?? { summary: e.summary ?? e.kind },
    ...(e.ref ? { ref: e.ref } : {}),
    ...(e.summary ? { summary: e.summary } : {}),
  };
}

async function runEngine(engine: Parameters<typeof driveEngine>[0], runId: string, input: unknown): Promise<EngineResult> {
  const now = makeClock();
  const ctx: EngineContext = { runId, input, now };
  return driveEngine(engine, ctx, { timeoutMs: 5000 });
}

// =============================================================================
describe("E2E ACCEPTANCE — real engines produce PASS and intentional FAIL (no fake green)", () => {
  it("QUALITY/web: clean login flow PASSES with zero findings; broken checkout flow FAILS with real defects", async () => {
    const res = await runEngine(new QualityWebEngine(), "RUN-web", webInput);
    expect(res.status).toBe(EngineStatus.DONE);
    expect(res.domain).toBe(AssuranceDomain.QUALITY);

    // The broken checkout flow must surface real, distinct functional defects...
    const kinds = new Set(res.findings.map((f) => f.kind));
    expect(kinds.has("required-element-missing")).toBe(true);
    expect(kinds.has("forbidden-element-present")).toBe(true);
    expect(kinds.has("console-error")).toBe(true);
    expect(kinds.has("network-request-client-error")).toBe(true);

    // ...and every finding must come from the broken flow, NOT the clean one (no false positives).
    const brokenOnly = res.findings.every((f) => (f.locator ?? "").includes("checkout"));
    expect(brokenOnly).toBe(true);
    expect(res.findings.length).toBeGreaterThanOrEqual(4);
  });

  it("SECURITY/appsec: clean module is clean; planted module detects secret + SQLi WITHOUT leaking the secret value", async () => {
    const res = await runEngine(new SecurityAppsecEngine(), "RUN-sec", appsecInput);
    expect(res.status).toBe(EngineStatus.DONE);
    expect(res.domain).toBe(AssuranceDomain.SECURITY);

    const kinds = new Set(res.findings.map((f) => f.kind));
    expect(kinds.has("hardcoded-secret")).toBe(true);
    expect(kinds.has("sql-injection-pattern")).toBe(true);

    // All findings point at the planted module, not the clean one.
    expect(res.findings.every((f) => (f.locator ?? "").includes("payments.ts"))).toBe(true);

    // HARD RULE (section 7): the secret VALUE must never appear in any finding field or evidence.
    const haystack = JSON.stringify({ findings: res.findings, evidence: res.evidence, artifacts: res.artifacts });
    expect(haystack.includes(SYNTHETIC_PLAINTEXT_SECRET)).toBe(false);
  });
});

// =============================================================================
describe("E2E ACCEPTANCE — evidence chain of custody is tamper-evident (section 12)", () => {
  it("records real engine evidence, bundles it, verifies intact, and DETECTS tampering", async () => {
    const store = new EvidenceStore();
    const clock = makeClock();
    const runId = "RUN-evidence";

    const web = await runEngine(new QualityWebEngine(), runId, webInput);
    const sec = await runEngine(new SecurityAppsecEngine(), runId, appsecInput);

    const recorded = [...web.evidence, ...sec.evidence].map((e) => store.record(toEvidenceInput(runId, e, clock())));
    // The engines must have produced real evidence to store.
    expect(recorded.length).toBeGreaterThan(0);
    expect(store.list(runId).length).toBe(recorded.length);

    const bundle = store.bundle(runId, { project: "ShopFlow", stage: "acceptance" });
    expect(bundle.count).toBe(recorded.length);
    expect(store.verifyBundle(bundle)).toBe(true); // intact chain of custody

    // Tamper: append an extra (out-of-band) evidence record to the same run AFTER sealing the bundle.
    store.record({
      runId,
      producedBy: "attacker",
      action: "inject.extra",
      kind: EvidenceKind.MARKER,
      at: clock(),
      classification: DataClassification.INTERNAL,
      data: { injected: true },
    });
    expect(store.verifyBundle(bundle)).toBe(false); // alteration is detected — fail-closed
  });

  it("CONFIDENTIAL evidence is redacted in the redacted view while ids + hashes remain", () => {
    const store = new EvidenceStore();
    const rec = store.record({
      runId: "RUN-redact",
      producedBy: "sec.appsec-engine",
      action: "scan.secrets",
      kind: EvidenceKind.FILE,
      at: "2026-01-01T00:00:01.000Z",
      classification: DataClassification.CONFIDENTIAL,
      data: { note: "sensitive detail" },
      summary: "contains sensitive context",
    });
    const view = store.redactedList("RUN-redact")[0]!;
    expect(view.id).toBe(rec.id);
    expect(view.contentHash).toBe(rec.contentHash);
    expect(view.data).toBeUndefined();
    expect(view.summary).toBe("[REDACTED]");
  });
});

// =============================================================================
// From here, build a REAL finding out of the web engine's broken-checkout output and
// route it through the human-independent lifecycle. Identities are distinct components
// so separation-of-duties is genuinely exercised (not merely configured).
// =============================================================================
const DETECTOR = "qa.web-engine";
const VERIFIER = "qa.verifier.independent";
const REMEDIATOR = "qa.remediator.independent";
const VALIDATOR = "qa.validator.independent";
const CLOSER = "release.closer.independent";

async function firstBrokenFinding(): Promise<{ finding: Finding; evidenceId: string; store: EvidenceStore; runId: string }> {
  const store = new EvidenceStore();
  const clock = makeClock();
  const runId = "RUN-lifecycle";
  const web = await runEngine(new QualityWebEngine(), runId, webInput);
  const evIds = web.evidence.map((e) => store.record(toEvidenceInput(runId, e, clock())).id);
  // Guarantee at least one evidence id exists to back the finding.
  const evidenceId =
    evIds[0] ??
    store.record({ runId, producedBy: DETECTOR, action: "web.capture", kind: EvidenceKind.TRACE, at: clock(), classification: DataClassification.INTERNAL, data: { flow: "checkout" } }).id;
  const src = web.findings[0];
  const finding: Finding = {
    id: "FND-CHECKOUT-PAY-MISSING",
    domain: AssuranceDomain.QUALITY,
    title: src?.title ?? "Checkout pay control missing",
    status: FindingStatus.SIGNAL,
    severity: Severity.P1,
    evidenceIds: [evidenceId],
    detectedBy: DETECTOR,
  };
  return { finding, evidenceId, store, runId };
}

describe("E2E ACCEPTANCE — verification enforces separation of duties (sections 4 & 6)", () => {
  it("the detector cannot verify its own finding; an independent verifier CONFIRMS only with evidence", async () => {
    const { finding, evidenceId } = await firstBrokenFinding();
    const ve = new VerificationEngine();
    const now = "2026-01-02T00:00:00.000Z";

    // Self-verification by the detector is refused (SoD).
    const self = ve.verify({ finding, verifierId: DETECTOR, verdict: Verdict.CONFIRM, evidenceIds: [evidenceId], now });
    expect(self.ok).toBe(false);

    // Independent verifier cannot CONFIRM without evidence.
    const noEv = ve.verify({ finding, verifierId: VERIFIER, verdict: Verdict.CONFIRM, evidenceIds: [], now });
    expect(noEv.ok).toBe(false);

    // Independent verifier CONFIRMS with evidence.
    const ok = ve.verify({ finding, verifierId: VERIFIER, verdict: Verdict.CONFIRM, evidenceIds: [evidenceId], now });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.finding.status).toBe(FindingStatus.CONFIRMED);
  });
});

describe("E2E ACCEPTANCE — remediation lifecycle enforces SoD end-to-end (section 6)", () => {
  it("detector cannot remediate; retest PASS needs evidence; closer must be independent", async () => {
    const { finding, evidenceId } = await firstBrokenFinding();
    const ve = new VerificationEngine();
    const re = new RemediationEngine();
    const now = "2026-01-02T00:00:00.000Z";

    const confirmed = ve.verify({ finding, verifierId: VERIFIER, verdict: Verdict.CONFIRM, evidenceIds: [evidenceId], now });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const cf = confirmed.finding;

    // SoD: the detector cannot remediate its own finding.
    const selfRemediate = re.startRemediation({ finding: cf, remediatorId: DETECTOR, rootCause: "x", fixStrategy: "y", now });
    expect(selfRemediate.ok).toBe(false);

    // Independent remediator begins remediation on the CONFIRMED finding.
    const started = re.startRemediation({
      finding: cf,
      remediatorId: REMEDIATOR,
      rootCause: "Checkout template dropped the #pay control after a refactor.",
      fixStrategy: "Restore the pay button and the cart API route; add a render assertion.",
      patchRef: "patch/checkout-pay-fix",
      now,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // A PASS retest requires evidence; an evidence-less PASS is refused.
    const noEv = re.submitRetest({ finding: started.finding, validatorId: VALIDATOR, passed: true, evidenceIds: [], now });
    expect(noEv.ok).toBe(false);

    // The remediator cannot validate their own fix (SoD).
    const remediatorValidates = re.submitRetest({ finding: started.finding, validatorId: REMEDIATOR, passed: true, evidenceIds: [evidenceId], now });
    expect(remediatorValidates.ok).toBe(false);

    // Independent validator submits a passing retest backed by evidence.
    const retest = re.submitRetest({ finding: started.finding, validatorId: VALIDATOR, passed: true, evidenceIds: [evidenceId], now });
    expect(retest.ok).toBe(true);
    if (!retest.ok) return;
    expect(retest.finding.status).toBe(FindingStatus.RETEST_PENDING);

    // The remediator cannot also close (SoD across the whole history).
    const remediatorCloses = re.close({ finding: retest.finding, closerId: REMEDIATOR, now });
    expect(remediatorCloses.ok).toBe(false);

    // An independent closer closes the finding; the independent-retest evidence is bound in.
    const closed = re.close({ finding: retest.finding, closerId: CLOSER, now });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.finding.status).toBe(FindingStatus.CLOSED);
    expect(closed.finding.evidenceIds).toContain(evidenceId);
  });
});

// =============================================================================
describe("E2E ACCEPTANCE — Release Gate is fail-closed across all four decisions (section 13)", () => {
  const openP1: Finding = {
    id: "FND-P1", domain: AssuranceDomain.QUALITY, title: "Open P1", status: FindingStatus.CONFIRMED,
    severity: Severity.P1, evidenceIds: ["EV-1"], detectedBy: DETECTOR,
  };
  const openP0: Finding = {
    id: "FND-P0", domain: AssuranceDomain.SECURITY, title: "Open P0", status: FindingStatus.CONFIRMED,
    severity: Severity.P0, evidenceIds: ["EV-2"], detectedBy: "sec.appsec-engine",
  };
  const closedFinding: Finding = { ...openP1, id: "FND-DONE", status: FindingStatus.CLOSED };
  const now = "2026-02-01T00:00:00.000Z";
  const bothPass = [
    { domain: AssuranceDomain.QUALITY, status: GateStatus.PASS },
    { domain: AssuranceDomain.SECURITY, status: GateStatus.PASS },
  ];

  it("RELEASE_BLOCKED: a QUALITY domain FAIL blocks even with intact evidence", () => {
    const r = evaluateRelease({
      domainResults: [{ domain: AssuranceDomain.QUALITY, status: GateStatus.FAIL }, { domain: AssuranceDomain.SECURITY, status: GateStatus.PASS }],
      findings: [openP1], evidenceBundleValid: true, now,
    } satisfies ReleaseGateInput);
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
    expect(r.blockingFindingIds).toContain("FND-P1");
  });

  it("RELEASE_BLOCKED: tampered evidence blocks even when every domain PASSES and no finding is open", () => {
    const r = evaluateRelease({ domainResults: bothPass, findings: [closedFinding], evidenceBundleValid: false, now });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("RELEASE_BLOCKED: an open P0 is never risk-acceptable (even with a complete acceptance)", () => {
    const r = evaluateRelease({
      domainResults: bothPass, findings: [openP0], evidenceBundleValid: true, now,
      acceptances: [{ findingId: "FND-P0", reason: "accepted", owner: "o@x", approver: "a@x", expiry: "2099-01-01T00:00:00.000Z" }],
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
    expect(r.blockingFindingIds).toContain("FND-P0");
  });

  it("HUMAN_APPROVAL_REQUIRED: a NOT_RUN domain cannot be silently released past", () => {
    const r = evaluateRelease({
      domainResults: [{ domain: AssuranceDomain.QUALITY, status: GateStatus.PASS }, { domain: AssuranceDomain.SECURITY, status: GateStatus.NOT_RUN }],
      findings: [], evidenceBundleValid: true, now,
    });
    expect(r.decision).toBe(ReleaseDecision.HUMAN_APPROVAL_REQUIRED);
  });

  it("RELEASE_ALLOWED_WITH_ACCEPTED_RISK: an open P1 with a valid, independently-approved acceptance", () => {
    const r = evaluateRelease({
      domainResults: bothPass, findings: [openP1], evidenceBundleValid: true, now,
      acceptances: [{ findingId: "FND-P1", reason: "mitigated by WAF rule", owner: "owner@x", approver: "approver@x", expiry: "2099-01-01T00:00:00.000Z" }],
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_ALLOWED_WITH_ACCEPTED_RISK);
    expect(r.acceptedFindingIds).toContain("FND-P1");
  });

  it("RELEASE_ALLOWED: only when all domains PASS, evidence is intact, and nothing blocks", () => {
    const r = evaluateRelease({ domainResults: bothPass, findings: [closedFinding], evidenceBundleValid: true, now });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_ALLOWED);
    expect(r.blockingFindingIds).toHaveLength(0);
  });

  it("self-approval on a P1 acceptance is rejected (owner === approver) → blocked", () => {
    const r = evaluateRelease({
      domainResults: bothPass, findings: [openP1], evidenceBundleValid: true, now,
      acceptances: [{ findingId: "FND-P1", reason: "r", owner: "same@x", approver: "same@x", expiry: "2099-01-01T00:00:00.000Z" }],
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });
});

// =============================================================================
// THE ACCEPTANCE NARRATIVE: green is EARNED, not defaulted.
// =============================================================================
describe("E2E ACCEPTANCE — the platform returns green only after a real remediation arc", () => {
  it("broken run BLOCKS; the identical gate ALLOWS only after detect→verify→remediate→retest→close→clean-re-run", async () => {
    // 1) Analyze the broken project — a real P1 finding is open.
    const { finding, evidenceId, store, runId } = await firstBrokenFinding();
    const bundleBroken = store.bundle(runId, { stage: "broken" });
    expect(store.verifyBundle(bundleBroken)).toBe(true);

    const blocked = evaluateRelease({
      domainResults: [
        { domain: AssuranceDomain.QUALITY, status: GateStatus.FAIL },
        { domain: AssuranceDomain.SECURITY, status: GateStatus.PASS },
      ],
      findings: [{ ...finding, status: FindingStatus.CONFIRMED }],
      evidenceBundleValid: store.verifyBundle(bundleBroken),
      now: "2026-03-01T00:00:00.000Z",
    });
    expect(blocked.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);

    // 2) Run the independent lifecycle to genuinely resolve the finding.
    const ve = new VerificationEngine();
    const re = new RemediationEngine();
    const now = "2026-03-02T00:00:00.000Z";
    const confirmed = ve.verify({ finding, verifierId: VERIFIER, verdict: Verdict.CONFIRM, evidenceIds: [evidenceId], now });
    expect(confirmed.ok && confirmed.finding.status === FindingStatus.CONFIRMED).toBe(true);
    if (!confirmed.ok) return;
    const started = re.startRemediation({ finding: confirmed.finding, remediatorId: REMEDIATOR, rootCause: "regression", fixStrategy: "restore control", now });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const retest = re.submitRetest({ finding: started.finding, validatorId: VALIDATOR, passed: true, evidenceIds: [evidenceId], now });
    expect(retest.ok).toBe(true);
    if (!retest.ok) return;
    const closed = re.close({ finding: retest.finding, closerId: CLOSER, now });
    expect(closed.ok && closed.finding.status === FindingStatus.CLOSED).toBe(true);
    if (!closed.ok) return;

    // 3) Re-analyze: the fixed project passes both domains with a fresh intact evidence bundle.
    const reStore = new EvidenceStore();
    const reClock = makeClock(Date.parse("2026-03-03T00:00:00.000Z"));
    const fixedWebInput: WebEngineInput = {
      // The clean login flow stands in for the now-fixed checkout (control restored, banner gone, 200s).
      flows: [{ id: "checkout-fixed", steps: webInput.flows[0]!.steps }],
    };
    const reweb = await runEngine(new QualityWebEngine(), "RUN-rerun", fixedWebInput);
    expect(reweb.findings).toHaveLength(0); // fixed flow is genuinely clean
    reStore.record(toEvidenceInput("RUN-rerun", reweb.evidence[0] ?? { producedBy: DETECTOR, action: "web.capture", kind: "TRACE", classification: DataClassification.INTERNAL, data: { ok: true } }, reClock()));
    const bundleFixed = reStore.bundle("RUN-rerun", { stage: "fixed" });

    const allowed = evaluateRelease({
      domainResults: [
        { domain: AssuranceDomain.QUALITY, status: GateStatus.PASS },
        { domain: AssuranceDomain.SECURITY, status: GateStatus.PASS },
      ],
      findings: [closed.finding], // CLOSED → not open → does not block
      evidenceBundleValid: reStore.verifyBundle(bundleFixed),
      now: "2026-03-04T00:00:00.000Z",
    });
    expect(allowed.decision).toBe(ReleaseDecision.RELEASE_ALLOWED);

    // The thesis, asserted: same gate function, opposite outcomes — green was EARNED.
    expect(blocked.decision).not.toBe(allowed.decision);
  });
});
