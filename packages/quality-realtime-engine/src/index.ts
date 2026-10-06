// @uaap/quality-realtime-engine — a realtime / event / message-queue assurance engine on the
// @uaap/engine-core lifecycle. It validates a recorded message STREAM (WebSocket frames, events,
// queue messages) against a channel contract: event-type coverage, payload schema (Ajv), required
// headers, ordering invariants (total / per-key sequence monotonicity, duplicate detection), and
// delivery acknowledgement. OFFLINE-ONLY: it inspects captured streams (local fixtures today; a
// broker-backed subscriber later) — it never connects to a broker, so there is no Agent->Target
// path and nothing to authorize. Fail-closed and total: malformed structural input is surfaced as a
// finding and never crashes the run or masks a real violation; a clean stream yields zero findings.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
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

export type OrderingMode = "none" | "total" | "per-key";
export interface EventSpec {
  readonly type: string;
  readonly schema?: object;
  readonly requiredHeaders?: readonly string[];
}
export interface ChannelSpec {
  readonly name: string;
  readonly events: readonly EventSpec[];
  readonly ordering?: OrderingMode;
  readonly orderKey?: string;
  readonly requireAck?: boolean;
}
export interface RealtimeContracts {
  readonly channels: readonly ChannelSpec[];
}
export interface StreamMessage {
  readonly type: string;
  readonly seq?: number;
  readonly key?: string;
  readonly ts?: string | number;
  readonly payload?: unknown;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly acked?: boolean;
}
export interface RealtimeEngineInput {
  readonly contracts: RealtimeContracts;
  readonly streams: Readonly<Record<string, ReadonlyArray<StreamMessage>>>;
}

const SEV = { P0: "P0", P1: "P1", P2: "P2", P3: "P3" } as const;
const ORDERING_MODES: ReadonlySet<string> = new Set(["none", "total", "per-key"]);

function classifyAjvError(e: ErrorObject): { kind: string; severity: Severity } {
  switch (e.keyword) {
    case "additionalProperties":
      return { kind: "payload-schema-drift", severity: SEV.P2 };
    case "required":
      return { kind: "payload-missing-field", severity: SEV.P1 };
    case "format":
      return { kind: "payload-format-violation", severity: SEV.P2 };
    default:
      return { kind: "payload-contract-violation", severity: SEV.P1 };
  }
}
function lc(headers: Readonly<Record<string, unknown>> | undefined): Set<string> {
  return new Set(Object.keys(headers ?? {}).map((h) => h.toLowerCase()));
}

export class QualityRealtimeEngine implements ExecutionEngine {
  // ajv-formats is registered so declared `format` constraints (email/uuid/date-time/…) are actually
  // validated — without it Ajv silently ignores `format` (a false green on the payload contract).
  private readonly ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));

  capabilities(): EngineCapabilities {
    return {
      engineId: "qa.realtime-engine",
      domain: "QUALITY",
      version: "0.1.0",
      capabilities: ["realtime.event-coverage", "realtime.payload-contract", "realtime.headers", "realtime.ordering", "realtime.duplicates", "realtime.delivery-ack"],
      offlineOnly: true,
    };
  }
  health(): EngineHealth {
    return { status: HealthStatus.HEALTHY };
  }

  private input(ctx: EngineContext): RealtimeEngineInput {
    return ctx.input as RealtimeEngineInput;
  }
  private channelsOf(ctx: EngineContext): readonly ChannelSpec[] {
    const c = (this.input(ctx)?.contracts as { channels?: unknown })?.channels;
    return Array.isArray(c) ? (c as ChannelSpec[]) : [];
  }

  discover(ctx: EngineContext): Discovery {
    const streams = this.input(ctx)?.streams;
    const channels = this.channelsOf(ctx);
    return {
      items: channels.map((c) => c?.name),
      summary: `${channels.length} channel(s); ${streams && typeof streams === "object" ? Object.keys(streams).length : 0} stream(s)`,
    };
  }

  plan(ctx: EngineContext, _discovery: Discovery): EnginePlan {
    const streams = this.input(ctx)?.streams;
    const names = streams && typeof streams === "object" ? Object.keys(streams) : [];
    return { steps: names.map((n) => ({ channel: n })), summary: `validate ${names.length} stream(s)` };
  }

  validatePrereqs(ctx: EngineContext, _plan: EnginePlan): PrereqResult {
    const input = this.input(ctx);
    const missing: string[] = [];
    if (!input || typeof input !== "object") missing.push("input is missing");
    else {
      if (!input.contracts || !Array.isArray(input.contracts.channels) || input.contracts.channels.length === 0) missing.push("contracts.channels is empty");
      if (!input.streams || typeof input.streams !== "object") missing.push("streams is missing");
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  private compile(schema: object): { validate: ValidateFunction } | { error: string } {
    try {
      return { validate: this.ajv.compile(schema) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken, collector: EngineCollector): void {
    const input = this.input(ctx);
    const streams = input?.streams && typeof input.streams === "object" ? input.streams : {};

    // Admit well-formed channels only (object + string name + events array).
    const channelByName = new Map<string, ChannelSpec>();
    for (const c of this.channelsOf(ctx)) {
      if (c && typeof c === "object" && typeof c.name === "string" && Array.isArray(c.events)) channelByName.set(c.name, c);
      else collector.finding(finding({ severity: SEV.P2, kind: "malformed-channel", title: "Malformed channel in contract", detail: "A channel is null, has no string name, or has no events array; skipped.", locator: "contracts.channels" }));
    }

    // Stream channels not declared in the contract.
    for (const name of Object.keys(streams)) {
      if (!channelByName.has(name)) collector.finding(finding({ severity: SEV.P2, kind: "unknown-channel", title: "Stream channel not in contract", detail: `Stream "${name}" is not declared in contracts.channels.`, locator: `streams.${name}` }));
    }

    let inspected = 0;
    for (const channel of channelByName.values()) {
      token.throwIfCancelled();
      const loc = `channel ${channel.name}`;
      try {
        const raw = streams[channel.name];
        if (!Array.isArray(raw)) {
          collector.finding(finding({ severity: SEV.P3, kind: "channel-not-in-stream", title: "Declared channel has no recorded stream", detail: `Channel "${channel.name}" is declared but has no messages in streams; not inspected.`, locator: loc }));
          continue;
        }
        inspected++;
        let violations = 0;
        const add = (f: EngineFinding) => {
          violations++;
          collector.finding(f);
        };

        // Event-type map (admit well-formed event specs only).
        const eventByType = new Map<string, EventSpec>();
        for (const e of channel.events as unknown[]) {
          if (e && typeof e === "object" && typeof (e as EventSpec).type === "string") eventByType.set((e as EventSpec).type, e as EventSpec);
          else add(finding({ severity: SEV.P2, kind: "malformed-event-spec", title: "Malformed event spec", detail: `An event spec on "${channel.name}" is null or has no string type; skipped.`, locator: loc }));
        }

        // Isolate malformed messages up front.
        const valid: { m: StreamMessage; i: number }[] = [];
        raw.forEach((m, i) => {
          if (m && typeof m === "object" && !Array.isArray(m)) valid.push({ m: m as StreamMessage, i });
          else add(finding({ severity: SEV.P1, kind: "malformed-message", title: "Malformed message", detail: `Message ${i} on "${channel.name}" is null or not an object.`, locator: `${loc} msg[${i}]` }));
        });

        // Per-message: delivery ack (channel-level — checked for EVERY message, independent of the
        // event type), then event coverage, payload contract, required headers.
        for (const { m, i } of valid) {
          const mloc = `${loc} msg[${i}]`;
          if (channel.requireAck && m.acked !== true) {
            add(finding({ severity: SEV.P1, kind: "unacked-message", title: "Unacknowledged message", detail: `Channel "${channel.name}" requires acknowledgement but message ${i} is not acked.`, locator: mloc }));
          }
          const ev = typeof m.type === "string" ? eventByType.get(m.type) : undefined;
          if (!ev) {
            add(finding({ severity: SEV.P2, kind: "unknown-event-type", title: "Undeclared event type", detail: `Message type "${String(m.type)}" is not declared on channel "${channel.name}".`, locator: mloc }));
            continue;
          }
          if (ev.schema) {
            const c = this.compile(ev.schema);
            if ("error" in c) add(finding({ severity: SEV.P2, kind: "invalid-contract-schema", title: "Event payload schema is invalid", detail: c.error, locator: mloc }));
            else if (!(c.validate(m.payload) as boolean)) {
              for (const e of c.validate.errors ?? []) {
                const { kind, severity } = classifyAjvError(e);
                add(finding({ severity, kind, title: "Payload contract violation", detail: `${e.instancePath || "/"} ${e.message ?? ""}`.trim(), locator: mloc }));
              }
            }
          }
          const present = lc(m.headers);
          for (const h of Array.isArray(ev.requiredHeaders) ? ev.requiredHeaders : []) {
            const name = String(h); // tolerate a non-string header name without throwing
            if (!present.has(name.toLowerCase())) add(finding({ severity: SEV.P2, kind: "missing-message-header", title: "Missing required message header", detail: `Message is missing required header "${name}".`, locator: mloc }));
          }
        }

        // Ordering invariants (fail-closed on an unrecognized mode AND on a declared-but-unordered
        // channel: a total/per-key channel whose messages carry no seq is NOT silently passed).
        const mode = channel.ordering ?? "none";
        if (!ORDERING_MODES.has(mode)) {
          add(finding({ severity: SEV.P2, kind: "unknown-ordering-mode", title: "Unknown ordering mode", detail: `Channel "${channel.name}" declares ordering "${String(mode)}" which is not one of none/total/per-key.`, locator: loc }));
        } else if (mode === "total") {
          this.checkSequence(valid, loc, add);
        } else if (mode === "per-key") {
          // Partition on the field named by channel.orderKey (falling back to "key"), keyed by a
          // TYPE-PRESERVING representation so numeric 1 and string "1" never collide.
          const field = typeof channel.orderKey === "string" && channel.orderKey ? channel.orderKey : "key";
          const groups = new Map<string, { m: StreamMessage; i: number }[]>();
          for (const v of valid) {
            const gk = JSON.stringify((v.m as unknown as Record<string, unknown>)[field] ?? null);
            let arr = groups.get(gk);
            if (!arr) {
              arr = [];
              groups.set(gk, arr);
            }
            arr.push(v);
          }
          for (const g of groups.values()) this.checkSequence(g, loc, add);
        }

        collector.evidence({
          producedBy: "qa.realtime-engine",
          action: "realtime.stream.validate",
          kind: "METRIC",
          classification: "INTERNAL",
          summary: `channel ${channel.name}: ${raw.length} message(s), ${violations} violation(s)`,
          data: { channel: channel.name, messages: raw.length, violations, ordering: mode, at: ctx.now() },
        });
      } catch (e) {
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while checking channel", detail: e instanceof Error ? e.message : String(e), locator: loc }));
      }
    }

    collector.artifact({
      kind: "realtime-validation-summary",
      summary: `${inspected}/${channelByName.size} declared channel(s) inspected`,
      data: { declaredChannels: channelByName.size, inspectedChannels: inspected },
    });
  }

  /**
   * Strictly-increasing sequence check + duplicate detection over an ORDERED group. Because the
   * channel declares an ordering invariant, a message WITHOUT a finite numeric seq is unorderable and
   * is flagged (missing-sequence) rather than silently skipped — an ordered channel can never pass
   * without its ordering actually being verified.
   */
  private checkSequence(items: readonly { m: StreamMessage; i: number }[], loc: string, add: (f: EngineFinding) => void): void {
    let prev: number | undefined;
    const seenSeq = new Set<number>();
    for (const { m, i } of items) {
      const at = `${loc} msg[${i}]`;
      if (typeof m.seq !== "number" || !Number.isFinite(m.seq)) {
        add(finding({ severity: SEV.P2, kind: "missing-sequence", title: "Missing sequence on ordered channel", detail: `Message has no numeric seq but its channel declares an ordering invariant; ordering cannot be verified.`, locator: at }));
        continue;
      }
      if (seenSeq.has(m.seq)) add(finding({ severity: SEV.P1, kind: "duplicate-sequence", title: "Duplicate sequence number", detail: `seq ${m.seq} occurs more than once.`, locator: at }));
      seenSeq.add(m.seq);
      if (prev !== undefined && m.seq <= prev) add(finding({ severity: SEV.P1, kind: "ordering-violation", title: "Out-of-order message", detail: `seq ${m.seq} is not strictly greater than the previous ${prev}.`, locator: at }));
      prev = m.seq;
    }
  }
}
