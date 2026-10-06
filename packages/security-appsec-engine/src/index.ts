// @uaap/security-appsec-engine — a DETECTION-ONLY, STATIC application-security engine on the
// @uaap/engine-core lifecycle. It inspects provided LOCAL artifacts (source snippets, config files,
// captured response headers, a dependency manifest with provided advisories, captured TLS settings)
// for common appsec weaknesses: hardcoded secrets, injection-prone code patterns, insecure
// configuration, missing/permissive security headers, known-vulnerable dependencies, and weak TLS.
//
// HARD CONSTRAINTS (platform non-negotiables):
//  - DETECTION ONLY. It never executes code, never sends a request, never touches a live target, and
//    never performs or simulates exploitation. There is no Agent→Target path; nothing to authorize.
//    Active validation against a real target is a SEPARATE capability that stays LOCKED_BY_DESIGN.
//  - Every finding is a detection SIGNAL that REQUIRES independent verification — a detector is not a
//    closure authority. Findings say "potential/detected", never "confirmed/exploited".
//  - NO SECRET VALUES in findings or evidence: a matched secret is redacted to its pattern + location.
import type { Severity } from "@uaap/core";
import {
  CancellationToken,
  finding,
  HealthStatus,
  type Discovery,
  type EngineCapabilities,
  type EngineCollector,
  type EngineContext,
  type EngineFinding,
  type EngineHealth,
  type EnginePlan,
  type ExecutionEngine,
  type PrereqResult,
} from "@uaap/engine-core";

export interface SourceArtifact {
  readonly path: string;
  readonly content: string;
}
export interface HeaderSet {
  readonly id: string;
  readonly headers: Readonly<Record<string, unknown>>;
}
export interface Advisory {
  readonly id: string;
  readonly severity?: Severity;
  /** Versions this advisory applies to; omitted => treated as applying (fail-closed). */
  readonly affected?: readonly string[];
}
export interface DependencyArtifact {
  readonly name: string;
  readonly version: string;
  readonly advisories?: readonly Advisory[];
}
export interface TlsArtifact {
  readonly host: string;
  readonly protocol?: string;
  readonly cipher?: string;
}
export interface AppsecEngineInput {
  readonly sources?: readonly SourceArtifact[];
  readonly config?: readonly SourceArtifact[];
  readonly headers?: readonly HeaderSet[];
  readonly dependencies?: readonly DependencyArtifact[];
  readonly tls?: readonly TlsArtifact[];
}

const SEV = { P0: "P0", P1: "P1", P2: "P2", P3: "P3" } as const;

interface LineRule {
  readonly kind: string;
  readonly severity: Severity;
  readonly title: string;
  readonly re: RegExp;
  /** True if the match may contain a secret value and must be fully redacted in the finding. */
  readonly redact?: boolean;
}

// Detection heuristics. Conservative by design; each is a SIGNAL requiring verification.
const SECRET_RULES: readonly LineRule[] = [
  { kind: "hardcoded-secret", severity: SEV.P1, title: "Potential AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/, redact: true },
  { kind: "hardcoded-secret", severity: SEV.P1, title: "Private key material", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, redact: true },
  { kind: "hardcoded-secret", severity: SEV.P1, title: "Potential Slack token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/, redact: true },
  { kind: "hardcoded-secret", severity: SEV.P2, title: "Potential JWT literal", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/, redact: true },
  // Assigned credential with a concrete (non env-reference) value. The key may be a COMPOUND /
  // snake_case name that CONTAINS a credential word (db_password, aws_secret_access_key, app_secret,
  // auth_token, private_key…) and may be quoted ("password":). Env references (${X}, <X>, {X}) are
  // excluded via the value's first-char class. (Detection only; the value is never echoed anyway.)
  // The credential word must be the END of the key (optionally with a prefix), so auth_token /
  // db_password / aws_secret_access_key match but DESCRIPTOR keys like token_type / tokenEndpoint /
  // secretName / access_token_url do NOT (the word there is a prefix/middle segment). The value must
  // not be a well-known public constant (Bearer/Basic/Digest/true/false/null) or a URL.
  { kind: "hardcoded-secret", severity: SEV.P2, title: "Hardcoded credential assignment", re: /["']?[A-Za-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credential|token)["']?\s*[:=]\s*["'](?!(?:bearer|basic|digest|true|false|null)["'])(?!https?:\/\/)[^"'$<{][^"']{3,}["']/i, redact: true },
];
const INJECTION_RULES: readonly LineRule[] = [
  { kind: "sql-injection-pattern", severity: SEV.P2, title: "Potential SQL injection (string interpolation into SQL)", re: /["'`](?:select|insert|update|delete)\b[^"'`]*\$\{/i },
  // Concatenation: require a QUOTED string literal that contains a SQL verb AND a clause keyword,
  // immediately followed by `+` — high-signal, avoids flagging ordinary English prose like
  // "update the record " + name.
  { kind: "sql-injection-pattern", severity: SEV.P2, title: "Potential SQL injection (string concatenation into SQL)", re: /["'`](?:select|insert|update|delete)\b[^"'`]*\b(?:from|into|where|values|set|join)\b[^"'`]*["'`]\s*\+/i },
  { kind: "command-injection-pattern", severity: SEV.P1, title: "Potential command injection (interpolated exec)", re: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{/ },
  { kind: "code-eval", severity: SEV.P2, title: "Use of eval()", re: /\beval\s*\(/ },
  // Assignment (=), NOT a comparison (==/===): `.innerHTML = x` is a sink; `.innerHTML === y` is not.
  { kind: "xss-sink", severity: SEV.P2, title: "Potential XSS sink", re: /\.innerHTML\s*=(?!=)|dangerouslySetInnerHTML/ },
];
// Config rules tolerate an optional closing quote before the separator so JSON (`"debug": true`) is
// covered as well as env/JS (`debug=true` / `debug: true`).
const CONFIG_RULES: readonly LineRule[] = [
  { kind: "insecure-tls-verification-disabled", severity: SEV.P1, title: "TLS certificate verification disabled", re: /(?:rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED)["']?\s*[:=]\s*["']?(?:false|0)\b/i },
  { kind: "debug-enabled", severity: SEV.P2, title: "Debug mode enabled in configuration", re: /\bdebug\b["']?\s*[:=]\s*true/i },
  { kind: "ssl-disabled", severity: SEV.P2, title: "SSL/TLS disabled in configuration", re: /\bssl\b["']?\s*[:=]\s*false/i },
];

const REQUIRED_SECURITY_HEADERS = ["content-security-policy", "x-content-type-options", "strict-transport-security", "x-frame-options"] as const;
const WEAK_TLS_PROTOCOLS = new Set(["ssl", "sslv2", "sslv3", "tls1", "tls1.0", "tlsv1", "tlsv1.0", "tls1.1", "tlsv1.1"]);
const WEAK_CIPHER_RE = /\b(?:rc4|null|export|3?des|tripledes|triple|md5|anon)\b/i;

/**
 * Scan a line against each rule. A finding reports only the rule TITLE and the LOCATION
 * (path:line) — it NEVER echoes raw line content. This is an allowlist stance, not a denylist: by
 * never reproducing any part of the inspected source, a secret of ANY shape (recognized or not —
 * snake_case keys, embedded-quote values, unquoted/$-prefixed values, GitHub/Google tokens,
 * high-entropy literals) can never leak into a finding or evidence, including via a non-secret rule
 * that happens to match the same line. The reader looks at `path:line` in the source to see context.
 */
function scanLines(artifact: SourceArtifact, rules: readonly LineRule[], add: (f: EngineFinding) => void, catLoc: string): void {
  const lines = String(artifact.content ?? "").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.re.test(line)) {
        add(
          finding({
            severity: rule.severity,
            kind: rule.kind,
            title: rule.title,
            detail: `${rule.title} detected at ${artifact.path}:${i + 1}${rule.redact ? " (value REDACTED)" : ""}. Detection signal — requires independent verification. (Line content is not reproduced; inspect the source at the given location.)`,
            locator: `${catLoc} ${artifact.path}:${i + 1}`,
          }),
        );
      }
    }
  });
}

export class SecurityAppsecEngine implements ExecutionEngine {
  capabilities(): EngineCapabilities {
    return {
      engineId: "sec.appsec-engine",
      domain: "SECURITY",
      version: "0.1.0",
      capabilities: ["sec.secrets", "sec.injection-patterns", "sec.insecure-config", "sec.security-headers", "sec.dependency-advisories", "sec.tls-config"],
      offlineOnly: true,
    };
  }
  health(): EngineHealth {
    return { status: HealthStatus.HEALTHY };
  }

  private input(ctx: EngineContext): AppsecEngineInput {
    return (ctx.input && typeof ctx.input === "object" ? ctx.input : {}) as AppsecEngineInput;
  }
  private arr<T>(v: unknown): readonly T[] {
    return Array.isArray(v) ? (v as T[]) : [];
  }

  discover(ctx: EngineContext): Discovery {
    const i = this.input(ctx);
    return {
      items: ["sources", "config", "headers", "dependencies", "tls"],
      summary: `sources=${this.arr(i.sources).length} config=${this.arr(i.config).length} headers=${this.arr(i.headers).length} deps=${this.arr(i.dependencies).length} tls=${this.arr(i.tls).length}`,
    };
  }
  plan(_ctx: EngineContext, _d: Discovery): EnginePlan {
    return { steps: ["secrets", "injection", "config", "headers", "dependencies", "tls"].map((s) => ({ check: s })), summary: "static detection-only appsec scan" };
  }
  validatePrereqs(ctx: EngineContext, _p: EnginePlan): PrereqResult {
    const i = this.input(ctx);
    const any = ["sources", "config", "headers", "dependencies", "tls"].some((k) => Array.isArray((i as Record<string, unknown>)[k]) && ((i as Record<string, unknown[]>)[k]!).length > 0);
    return any ? { ok: true } : { ok: false, missing: ["no artifacts provided (need at least one of sources/config/headers/dependencies/tls)"] };
  }

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken, collector: EngineCollector): void {
    const i = this.input(ctx);
    let signals = 0;
    const add = (f: EngineFinding) => {
      signals++;
      collector.finding(f);
    };
    const eachArtifact = (list: readonly SourceArtifact[], rules: readonly LineRule[], cat: string) => {
      list.forEach((a, idx) => {
        token.throwIfCancelled();
        if (!a || typeof a !== "object" || typeof a.path !== "string" || typeof a.content !== "string") {
          add(finding({ severity: SEV.P3, kind: "malformed-artifact", title: "Malformed artifact", detail: `${cat} artifact ${idx} is missing a string path/content; skipped.`, locator: cat }));
          return;
        }
        try {
          scanLines(a, rules, add, cat);
        } catch (e) {
          add(finding({ severity: SEV.P3, kind: "engine-error", title: "Engine error while scanning artifact", detail: e instanceof Error ? e.message : String(e), locator: `${cat} ${a.path}` }));
        }
      });
    };

    // Source scans (secrets + injection patterns); config scans (secrets + insecure config).
    eachArtifact(this.arr<SourceArtifact>(i.sources), [...SECRET_RULES, ...INJECTION_RULES], "source");
    eachArtifact(this.arr<SourceArtifact>(i.config), [...SECRET_RULES, ...CONFIG_RULES], "config");

    // Security headers (missing required + permissive CORS).
    for (const hs of this.arr<HeaderSet>(i.headers)) {
      token.throwIfCancelled();
      if (!hs || typeof hs !== "object" || typeof hs.id !== "string" || !hs.headers || typeof hs.headers !== "object") {
        add(finding({ severity: SEV.P3, kind: "malformed-artifact", title: "Malformed header set", detail: "A header set is missing a string id / headers object; skipped.", locator: "headers" }));
        continue;
      }
      const present = new Map<string, string>();
      for (const [k, v] of Object.entries(hs.headers)) present.set(k.toLowerCase(), String(v));
      for (const h of REQUIRED_SECURITY_HEADERS) {
        if (!present.has(h)) add(finding({ severity: SEV.P2, kind: "missing-security-header", title: `Missing security header: ${h}`, detail: `Response "${hs.id}" is missing "${h}". Detection signal — requires verification.`, locator: `headers ${hs.id}` }));
      }
      const acao = present.get("access-control-allow-origin");
      const acac = present.get("access-control-allow-credentials");
      if (acao === "*" && acac && acac.toLowerCase() === "true") {
        add(finding({ severity: SEV.P2, kind: "permissive-cors", title: "Permissive CORS with credentials", detail: `Response "${hs.id}" sets Access-Control-Allow-Origin: * together with credentials=true. Detection signal — requires verification.`, locator: `headers ${hs.id}` }));
      }
    }

    // Dependency advisories (SCA from PROVIDED advisories — never fetched).
    for (const dep of this.arr<DependencyArtifact>(i.dependencies)) {
      token.throwIfCancelled();
      if (!dep || typeof dep !== "object" || typeof dep.name !== "string" || typeof dep.version !== "string") {
        add(finding({ severity: SEV.P3, kind: "malformed-artifact", title: "Malformed dependency", detail: "A dependency is missing a string name/version; skipped.", locator: "dependencies" }));
        continue;
      }
      for (const adv of this.arr<Advisory>(dep.advisories)) {
        if (!adv || typeof adv !== "object" || typeof adv.id !== "string") continue;
        // Applies if no affected list (fail-closed) or the exact version is listed.
        const applies = !Array.isArray(adv.affected) || adv.affected.includes(dep.version);
        if (applies) add(finding({ severity: adv.severity ?? SEV.P2, kind: "vulnerable-dependency", title: `Vulnerable dependency: ${dep.name}@${dep.version}`, detail: `Advisory ${adv.id} applies to ${dep.name}@${dep.version}. Detection signal (from provided advisory) — requires verification.`, locator: `dependencies ${dep.name}` }));
      }
    }

    // TLS configuration (weak protocol / cipher).
    for (const t of this.arr<TlsArtifact>(i.tls)) {
      token.throwIfCancelled();
      if (!t || typeof t !== "object" || typeof t.host !== "string") {
        add(finding({ severity: SEV.P3, kind: "malformed-artifact", title: "Malformed TLS record", detail: "A TLS record is missing a string host; skipped.", locator: "tls" }));
        continue;
      }
      if (typeof t.protocol === "string" && WEAK_TLS_PROTOCOLS.has(t.protocol.toLowerCase().replace(/\s+/g, ""))) {
        add(finding({ severity: SEV.P1, kind: "weak-tls-protocol", title: "Weak TLS protocol", detail: `Host "${t.host}" negotiates ${t.protocol}, below TLS 1.2. Detection signal — requires verification.`, locator: `tls ${t.host}` }));
      }
      if (typeof t.cipher === "string" && WEAK_CIPHER_RE.test(t.cipher)) {
        add(finding({ severity: SEV.P2, kind: "weak-tls-cipher", title: "Weak TLS cipher", detail: `Host "${t.host}" uses a weak cipher "${t.cipher}". Detection signal — requires verification.`, locator: `tls ${t.host}` }));
      }
    }

    collector.evidence({
      producedBy: "sec.appsec-engine",
      action: "sec.static.detect",
      kind: "MARKER",
      classification: "INTERNAL",
      summary: `static detection-only scan: ${signals} signal(s) across ${this.arr(i.sources).length + this.arr(i.config).length} file(s), ${this.arr(i.headers).length} response(s), ${this.arr(i.dependencies).length} dep(s), ${this.arr(i.tls).length} tls record(s)`,
      data: { signals, mode: "DETECTION_ONLY", activeValidation: "LOCKED_BY_DESIGN", at: ctx.now() },
    });
    collector.artifact({ kind: "appsec-detection-summary", summary: `${signals} detection signal(s) — each requires independent verification (detector is not a closure authority)`, data: { signals, detectionOnly: true } });
  }
}
