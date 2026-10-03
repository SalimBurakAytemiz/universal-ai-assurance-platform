# Agent Role Migration Map

This maps every legacy role from the two source specs onto the 72 canonical agents
(9 guilds × 8). No legacy responsibility is dropped — it becomes a canonical agent plus
one or more **skills**. Format: `LEGACY ROLE → CANONICAL AGENT (id) → SKILL/CAPABILITY`.

> Agent ≠ Model ≠ Skill ≠ Tool ≠ Domain. A legacy "Playwright Agent" is not a canonical
> agent; it is the `Web UI Automation Agent` carrying the `playwright` skill.

## Legacy QA agents (AI_QA_COMMAND_CENTER spec §10)

| Legacy role | Canonical agent | id | Skill/capability |
|---|---|---|---|
| Target Config Agent | Repository Intelligence Agent | `proj.repository-intelligence` | target-config validation |
| Orchestrator Agent | Master Orchestrator Agent | `gov.master-orchestrator` | orchestration |
| API Contract Agent | API Contract Agent | `qa.api-contract` | ajv, json-schema, openapi |
| Web UI Automation Agent | Web UI Automation Agent | `qa.web-ui-automation` | web automation |
| Playwright Agent | Web UI Automation Agent | `qa.web-ui-automation` | playwright |
| Selenium Compatibility Agent | Web UI Automation Agent | `qa.web-ui-automation` | selenium-compat |
| Appium Android Agent | Mobile Quality Agent | `qa.mobile-quality` | appium, android |
| Appium iOS Agent | Mobile Quality Agent | `qa.mobile-quality` | appium (future ios) |
| Socket/WebSocket Agent | Realtime Event Queue Quality Agent | `qa.realtime-event-queue-quality` | websocket |
| Database Validation Agent | Database And Migration Quality Agent | `qa.database-and-migration-quality` | db-readonly-validation |
| Performance Agent | Performance Engineering Agent | `dprp.performance-engineering` | k6-smoke |
| Security Baseline Agent | Source/Dependency/Secrets/Supply-Chain Security Agent | `sec.source-dependency-secrets-supply-chain-security` | dependency-audit (passive baseline) |
| Accessibility Agent | Visual And Accessibility Quality Agent | `qa.visual-and-accessibility-quality` | accessibility |
| Visual Regression Agent | Visual And Accessibility Quality Agent | `qa.visual-and-accessibility-quality` | visual-regression |
| Evidence Collector Agent | Evidence Collector Agent | `evr.evidence-collector` | artifact-capture |
| Report Generator Agent | Technical Report Agent | `biz.technical-report` | technical-reporting |
| Integration Dry-Run Agent | Integration Broker Agent | `auto.integration-broker` | integration-dry-run |
| SaaS Worker Agent | Worker Infrastructure Agent | `auto.worker-infrastructure` | worker-orchestration |
| Release Review Agent | Release Gate Agent | `evr.release-gate` | release-decision |

## Legacy Security roles (AI-SECURITY-FACTORY handoff §12)

| Legacy role | Canonical agent | id | Skill/capability |
|---|---|---|---|
| Security Orchestrator | Master Orchestrator Agent | `gov.master-orchestrator` | orchestration |
| Authorization Gate | Authorization Gate Agent | `gov.authorization-gate` | authorization |
| Scope Resolver | Scope Resolver Agent | `gov.scope-resolver` | scope-matching |
| Policy Decision | Policy Decision Agent | `gov.policy-decision` | policy-as-code |
| Audit & Provenance | Audit And Provenance Agent | `gov.audit-and-provenance` | audit, chain-of-custody |
| Human Approval Coordinator | Human Approval Coordinator Agent | `gov.human-approval-coordinator` | approval-workflow |
| Company Discovery | Prospect Intelligence Agent | `sec.prospect-intelligence` | passive-osint |
| Public Asset Mapping | Public Asset And Technology Intelligence Agent | `sec.public-asset-and-technology-intelligence` | dns-metadata |
| Public Technology Intelligence | Public Asset And Technology Intelligence Agent | `sec.public-asset-and-technology-intelligence` | certificate-metadata |
| Public Repository Exposure | Prospect Intelligence Agent | `sec.prospect-intelligence` | public-exposure |
| Public Advisory Correlation | Vulnerability And Advisory Intelligence Agent | `know.vulnerability-and-advisory-intelligence` | advisory |
| Prospect Risk Summary | Prospect Intelligence Agent | `sec.prospect-intelligence` | risk-hypothesis |
| Source Security | Source/Dependency/Secrets/Supply-Chain Security Agent | `sec.source-dependency-secrets-supply-chain-security` | sast-patterns |
| Dependency / Supply Chain | Source/Dependency/Secrets/Supply-Chain Security Agent | `sec.source-dependency-secrets-supply-chain-security` | dependency-audit, supply-chain |
| Secrets | Source/Dependency/Secrets/Supply-Chain Security Agent | `sec.source-dependency-secrets-supply-chain-security` | secret-scan |
| Web Security | Application Security Agent | `sec.application-security` | web-security |
| API Security | API Security Agent | `sec.api-security` | api-security |
| Identity & Access | Identity Access And Session Security Agent | `sec.identity-access-and-session-security` | identity |
| Business Logic Security | Identity Access And Session Security Agent | `sec.identity-access-and-session-security` | business-logic |
| Cloud Security | Cloud/Infra/IAM/Container/IaC/TLS Security Agent | `sec.cloud-infra-iam-container-iac-tls-security` | cloud-config |
| IAM Review | Cloud/Infra/IAM/Container/IaC/TLS Security Agent | `sec.cloud-infra-iam-container-iac-tls-security` | iam-review |
| Container Security | Cloud/Infra/IAM/Container/IaC/TLS Security Agent | `sec.cloud-infra-iam-container-iac-tls-security` | container |
| IaC Security | Cloud/Infra/IAM/Container/IaC/TLS Security Agent | `sec.cloud-infra-iam-container-iac-tls-security` | iac |
| TLS / Network Configuration | Cloud/Infra/IAM/Container/IaC/TLS Security Agent | `sec.cloud-infra-iam-container-iac-tls-security` | tls-config |
| (data/crypto/exposure) | Data Protection Cryptography Exposure Security Agent | `sec.data-protection-cryptography-exposure-security` | encryption-*, exposure-review |
| Finding Verifier | Finding Verifier Agent | `evr.finding-verifier` | independent-verification |
| False Positive Challenger | False Positive Challenger Agent | `evr.false-positive-challenger` | adversarial-review |
| Evidence Integrity | Evidence Integrity Agent | `evr.evidence-integrity` | hashing, chain-of-custody |
| Security Regression | Independent Regression Validator Agent | `evr.independent-regression-validator` | regression-retest |
| Root Cause | Root Cause Analysis Agent | `evr.root-cause-analysis` | rca |
| Fix Strategy | Remediation Agent | `evr.remediation` | patch-strategy |
| Patch / PR | Remediation Agent | `evr.remediation` | pr-authoring |
| Fix Review | Finding Verifier Agent | `evr.finding-verifier` | independent-verification |
| OWASP Mapper | Standards Intelligence Agent | `know.standards-intelligence` | owasp |
| CWE Mapper | Standards Intelligence Agent | `know.standards-intelligence` | cwe |
| CVE / Advisory Correlator | Vulnerability And Advisory Intelligence Agent | `know.vulnerability-and-advisory-intelligence` | cve-correlation |
| ATT&CK Mapper | Standards Intelligence Agent | `know.standards-intelligence` | attack |
| NIST / Risk Governance Mapper | Risk And Compliance Mapping Agent | `biz.risk-and-compliance-mapping` | control-mapping |
| Technical Report | Technical Report Agent | `biz.technical-report` | technical-reporting |
| Executive Report | Executive And Customer Assurance Agent | `biz.executive-and-customer-assurance` | executive-reporting |
| Customer Assurance | Executive And Customer Assurance Agent | `biz.executive-and-customer-assurance` | customer-assurance |
| Prospect Assessment | Prospect Intelligence Agent | `sec.prospect-intelligence` | prospect-assessment |

All canonical agent ids referenced above exist in `agents/registry/agents.json` (validated by
`scripts/validate-agent-registry.mjs` and `tests/integration/agent-registry.test.ts`).
