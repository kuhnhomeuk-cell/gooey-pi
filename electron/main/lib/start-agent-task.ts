import type { PrimeModelDescriptor, PrimeThinkingLevel, RuntimeInfo } from '../../../src/types/api'
import type { AgentRpcManager } from '../agent-rpc'
import { resolveModel, resolveReasoning } from '../model-selection'

/**
 * Shared interactive task-launch transaction used by voice start_task and
 * session collaboration create. Scheduled/unattended runs stay in the
 * schedule executor — they use a different start path and failure policy.
 */
export interface StartAgentTaskOptions {
  manager: Pick<AgentRpcManager, 'start' | 'command' | 'stop' | 'list'>
  cwd: string
  prompt: string
  availableModels: () => Promise<readonly PrimeModelDescriptor[]>
  title?: string
  modelQuery?: string
  reasoningQuery?: string
  /** Extra manager.start field; collaboration is the only current caller. */
  fast?: boolean
  missingSessionError: string
  onCleanup?: (runtimeId: string) => void
}

export interface StartedAgentTask {
  runtime: RuntimeInfo & { sessionFile: string }
  selectedModel?: PrimeModelDescriptor
  appliedReasoning?: PrimeThinkingLevel
}

export async function startAgentTask(options: StartAgentTaskOptions): Promise<StartedAgentTask> {
  const selectedModel = options.modelQuery ? resolveModel(options.modelQuery, await options.availableModels()) : undefined
  const selectedReasoning = selectedModel && options.reasoningQuery
    ? resolveReasoning(options.reasoningQuery, selectedModel.availableThinkingLevels)
    : undefined
  const runtime = await options.manager.start({
    cwd: options.cwd,
    ...(selectedModel ? { model: selectedModel.key } : {}),
    ...(selectedReasoning ? { thinking: selectedReasoning } : {}),
    ...(options.fast !== undefined ? { fast: options.fast } : {}),
  })
  const cleanup = async (): Promise<void> => {
    options.onCleanup?.(runtime.runtimeId)
    await options.manager.stop(runtime.runtimeId).catch(() => false)
  }
  let appliedReasoning = selectedReasoning
  try {
    if (!selectedModel && options.reasoningQuery) {
      appliedReasoning = resolveReasoning(options.reasoningQuery, runtime.availableThinkingLevels ?? [])
      await options.manager.command(runtime.runtimeId, { type: 'set_thinking_level', level: appliedReasoning })
    }
    await options.manager.command(runtime.runtimeId, { type: 'prompt', message: options.prompt })
    if (options.title) await options.manager.command(runtime.runtimeId, { type: 'set_session_name', name: options.title }).catch(() => undefined)
    await options.manager.command(runtime.runtimeId, { type: 'get_state' })
  } catch (error) {
    await cleanup()
    throw error
  }
  const current = options.manager.list().find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? runtime
  if (!current.sessionFile) {
    await cleanup()
    throw new Error(options.missingSessionError)
  }
  return { runtime: { ...current, sessionFile: current.sessionFile }, selectedModel, appliedReasoning }
}
