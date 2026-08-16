import type { PrimeEventEnvelope } from '../../../src/types/api'
import type { RpcObject } from './types'

export interface AgentEventLimits {
  maxEvents: number
  maxEnvelopeBytes: number
  maxWindowBytes: number
  windowMs: number
}

const DEFAULT_AGENT_EVENT_LIMITS: AgentEventLimits = {
  maxEvents: 500,
  maxEnvelopeBytes: 8 * 1024 * 1024,
  maxWindowBytes: 32 * 1024 * 1024,
  windowMs: 1_000,
}

/** Applies the same byte accounting to real and synthetic events before they reach Electron IPC. */
export class AgentEventForwarder {
  private readonly limits: AgentEventLimits
  private windowStarted = Date.now()
  private eventCount = 0
  private criticalEventCount = 0
  private windowBytes = 0
  private runtimeExitDelivered = false
  private readonly reportedLimits = new Set<string>()

  constructor(
    private readonly runtimeId: string,
    private readonly onEvent: (envelope: PrimeEventEnvelope) => void,
    limits: Partial<AgentEventLimits> = {},
    private readonly agentName = 'Prime Agent',
  ) {
    this.limits = { ...DEFAULT_AGENT_EVENT_LIMITS, ...limits }
  }

  emit(event: RpcObject): void {
    this.resetWindowIfNeeded()
    // runtime_exit is the renderer's only signal that the agent is gone; it is
    // exempt from the rate caps and always delivered exactly once.
    const isRuntimeExit = event.type === 'runtime_exit'
    const critical = isRuntimeExit
      || event.type === 'agent_start'
      || event.type === 'agent_end'
      || event.type === 'compaction_start'
      || event.type === 'compaction_end'
    if (isRuntimeExit) {
      if (this.runtimeExitDelivered) return
    } else if (critical) {
      this.criticalEventCount += 1
      if (this.criticalEventCount > 32) { this.reportLimit('critical-count', `${this.agentName} lifecycle event rate exceeded the desktop limit`); return }
    } else {
      this.eventCount += 1
      if (this.eventCount > this.limits.maxEvents) { this.reportLimit('count', `${this.agentName} event rate exceeded the desktop limit`); return }
    }

    const envelope: PrimeEventEnvelope = { runtimeId: this.runtimeId, event }
    const serialized = this.serializeEnvelope(envelope)
    if (serialized === null || serialized.bytes > this.limits.maxEnvelopeBytes) {
      this.reportLimit('envelope', `${this.agentName} event exceeded the desktop envelope byte limit`)
      return
    }
    if (!isRuntimeExit) {
      const reserve = Math.min(64 * 1024, Math.floor(this.limits.maxWindowBytes / 4))
      const byteLimit = critical ? this.limits.maxWindowBytes : this.limits.maxWindowBytes - reserve
      if (this.windowBytes + serialized.bytes > byteLimit) {
        this.reportLimit('bytes', `${this.agentName} event byte rate exceeded the desktop limit`)
        return
      }
    }
    this.windowBytes += serialized.bytes
    if (isRuntimeExit) this.runtimeExitDelivered = true
    this.onEvent(envelope)
  }

  private resetWindowIfNeeded(): void {
    const now = Date.now()
    if (now - this.windowStarted < this.limits.windowMs) return
    this.windowStarted = now
    this.eventCount = 0
    this.criticalEventCount = 0
    this.windowBytes = 0
    this.reportedLimits.clear()
  }

  private reportLimit(kind: string, error: string): void {
    if (this.reportedLimits.has(kind)) return
    this.reportedLimits.add(kind)
    // transport_limit, not transport_error: the desktop dropped events but the
    // agent is still running, so the renderer must reconcile the transcript
    // from disk rather than treat the turn as failed or finished.
    const envelope: PrimeEventEnvelope = { runtimeId: this.runtimeId, event: { type: 'transport_limit', kind, error } }
    const serialized = this.serializeEnvelope(envelope)
    if (serialized === null || serialized.bytes > this.limits.maxEnvelopeBytes || this.windowBytes + serialized.bytes > this.limits.maxWindowBytes) return
    this.windowBytes += serialized.bytes
    this.onEvent(envelope)
  }

  private serializeEnvelope(envelope: PrimeEventEnvelope): { json: string; bytes: number } | null {
    try {
      const json = JSON.stringify(envelope)
      return { json, bytes: Buffer.byteLength(json, 'utf8') }
    } catch {
      return null
    }
  }
}
