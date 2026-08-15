import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { FactoryState, FactoryStatus } from '../../src/types/api'
import { requireString } from './validation'
import { killProcessTree, registerChildProcess, runProcess, safeChildEnvironment, waitForProcessExit, type ProcessResult } from './process-utils'

const DEFAULT_DB = 'adws/adw_data/sssf.db'
const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_MS = 250
const INSTALL_TIMEOUT_MS = 120_000
const BUILD_TIMEOUT_MS = 180_000

export interface FactoryManagerOptions {
  runProcess?: typeof runProcess
  spawn?: typeof spawn
  fetch?: typeof fetch
  allocatePort?: () => Promise<number>
  now?: () => number
  delay?: (ms: number) => Promise<void>
  bun?: string
}

interface FactoryEntry {
  port: number
  child?: ChildProcess
  url?: string
  state: FactoryState
  message?: string
  generation: number
}

interface BootRecord {
  generation: number
  promise: Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms)
    timer.unref()
  })
}

function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, '').trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Reads `observability.db` from sssf.config.yaml (dotted or nested). */
export function parseObservabilityDb(text: string): string | undefined {
  const dotted = /^\s*observability\.db\s*:\s*(.+)$/m.exec(text)
  if (dotted) {
    const value = stripYamlScalar(dotted[1] ?? '')
    if (value) return value
  }
  const lines = text.split(/\r?\n/)
  let inObservability = false
  let baseIndent = 0
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue
    const indent = (/^\s*/.exec(line)?.[0].length) ?? 0
    if (!inObservability) {
      if (/^observability\s*:/.test(line)) {
        inObservability = true
        baseIndent = indent
      }
      continue
    }
    if (indent <= baseIndent) break
    const db = /^\s*db\s*:\s*(.+)$/.exec(line)
    if (db) {
      const value = stripYamlScalar(db[1] ?? '')
      if (value) return value
    }
  }
  return undefined
}

export async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    const fail = (error: Error): void => {
      server.close()
      reject(error)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        fail(new Error('Failed to allocate a TCP port'))
        return
      }
      const port = address.port
      server.close((error) => { if (error) reject(error); else resolvePort(port) })
    })
  })
}

async function resolveBunExecutable(): Promise<string> {
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const env = process.env
  const home = homedir()
  const directories: string[] = []
  if (env.BUN_INSTALL) directories.push(join(env.BUN_INSTALL, 'bin'))
  const pathKey = process.platform === 'win32' && env.Path !== undefined ? 'Path' : 'PATH'
  for (const directory of (env[pathKey] ?? '').split(delimiter)) if (directory) directories.push(directory)
  directories.push(join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  const seen = new Set<string>()
  for (const directory of directories) {
    const candidate = join(directory, executable)
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  return executable
}

async function canonicalize(projectPath: string): Promise<string> {
  const input = requireString(projectPath, 'projectPath', { min: 1, max: 4096 })
  if (!isAbsolute(input)) throw new TypeError('projectPath must be absolute')
  try {
    return await realpath(input)
  } catch {
    return resolve(input)
  }
}

function processFailed(result: ProcessResult, fallback: string): string | undefined {
  if (!result.timedOut && !result.outputExceeded && result.code === 0) return undefined
  const detail = result.stderr.trim() || result.stdout.trim()
  if (result.timedOut) return detail || `${fallback} timed out`
  if (result.outputExceeded) return detail || `${fallback} produced too much output`
  return detail || `${fallback} failed`
}

export class FactoryManager {
  private readonly entries = new Map<string, FactoryEntry>()
  private readonly boots = new Map<string, BootRecord[]>()
  private readonly generations = new Map<string, number>()
  private readonly healthAborts = new Map<string, Set<AbortController>>()
  private closed = false
  private readonly runProcessFn: typeof runProcess
  private readonly spawnFn: typeof spawn
  private readonly fetchFn: typeof fetch
  private readonly allocatePortFn: () => Promise<number>
  private readonly now: () => number
  private readonly delayFn: (ms: number) => Promise<void>
  private readonly bunOverride?: string

  constructor(options: FactoryManagerOptions = {}) {
    this.runProcessFn = options.runProcess ?? runProcess
    this.spawnFn = options.spawn ?? spawn
    this.fetchFn = options.fetch ?? fetch
    this.allocatePortFn = options.allocatePort ?? allocateEphemeralPort
    this.now = options.now ?? Date.now
    this.delayFn = options.delay ?? delay
    this.bunOverride = options.bun
  }

  async detect(projectPath: string): Promise<boolean> {
    const root = await canonicalize(projectPath)
    return await directoryExists(join(root, 'adws')) && await directoryExists(join(root, '.claude', 'skills', 'sssf'))
  }

  async status(projectPath: string): Promise<FactoryStatus> {
    const root = await canonicalize(projectPath)
    const entry = this.entries.get(root)
    if (entry) return this.toStatus(entry)
    return { state: 'none' }
  }

  async ensure(projectPath: string): Promise<FactoryStatus> {
    const root = await canonicalize(projectPath)
    if (this.closed) return { state: 'error', message: 'Factory manager is shutting down' }
    const live = this.liveEntry(root)
    if (live) return this.toStatus(live)
    this.beginBoot(root)
    const entry = this.entries.get(root)
    if (entry) return this.toStatus(entry)
    if (!(await this.detect(root))) return { state: 'none' }
    return { state: 'starting' }
  }

  async stop(projectPath: string): Promise<void> {
    const root = await canonicalize(projectPath)
    const boots = this.invalidate(root)
    const entry = this.entries.get(root)
    this.entries.delete(root)
    if (entry?.child) await this.killChild(entry.child)
    await Promise.all(boots.map((boot) => boot.promise))
  }

  async stopAll(): Promise<void> {
    this.closed = true
    const boots = [...this.boots.values()].flat()
    const entries = [...this.entries.values()]
    for (const root of [...this.generations.keys(), ...this.entries.keys(), ...this.boots.keys()]) this.bumpGeneration(root)
    this.abortAllHealth()
    this.entries.clear()
    this.boots.clear()
    await Promise.all(entries.map((entry) => entry.child ? this.killChild(entry.child) : Promise.resolve()))
    await Promise.all(boots.map((boot) => boot.promise))
  }

  private latestBoot(root: string): BootRecord | undefined {
    const records = this.boots.get(root)
    return records?.[records.length - 1]
  }

  private beginBoot(root: string): void {
    const current = this.generations.get(root) ?? 0
    const inFlight = this.latestBoot(root)
    const existing = this.entries.get(root)
    // A boot that already published 'error' may still be in flight (cleanup).
    // Retry must replace that stale entry with 'starting' now, not return it.
    if (inFlight && inFlight.generation === current && existing?.state !== 'error') return
    const previousChild = existing?.child
    // Lose ownership first so the disowned boot will not touch the shared entry,
    // then abort its health fetch and kill its child before publishing 'starting'.
    const generation = this.bumpGeneration(root)
    this.abortHealth(root)
    if (previousChild) void this.killChild(previousChild)
    if (existing) {
      this.entries.set(root, { port: 0, state: 'starting', generation })
    }
    const promise = this.boot(root, generation, previousChild).finally(() => {
      const records = this.boots.get(root)
      if (!records) return
      const remaining = records.filter((record) => record.promise !== promise)
      if (remaining.length > 0) this.boots.set(root, remaining)
      else this.boots.delete(root)
    })
    const records = this.boots.get(root)
    if (records) records.push({ generation, promise })
    else this.boots.set(root, [{ generation, promise }])
  }

  private invalidate(root: string): BootRecord[] {
    const boots = [...(this.boots.get(root) ?? [])]
    this.bumpGeneration(root)
    this.abortHealth(root)
    return boots
  }

  private bumpGeneration(root: string): number {
    const generation = (this.generations.get(root) ?? 0) + 1
    this.generations.set(root, generation)
    return generation
  }

  private owns(root: string, generation: number, entry?: FactoryEntry): boolean {
    return !this.closed && this.generations.get(root) === generation && (entry === undefined || this.entries.get(root) === entry)
  }

  private liveEntry(root: string): FactoryEntry | undefined {
    const entry = this.entries.get(root)
    if (!entry || entry.state === 'error' || entry.state === 'none') return undefined
    if (entry.child && !isChildAlive(entry.child)) return undefined
    return entry
  }

  private toStatus(entry: FactoryEntry): FactoryStatus {
    return {
      state: entry.state,
      url: entry.state === 'running' ? entry.url : undefined,
      message: entry.state === 'error' ? entry.message : undefined,
    }
  }

  private async resolveDb(root: string): Promise<string> {
    const configPath = join(root, 'adws', 'adw_sssf_config', 'sssf.config.yaml')
    try {
      const configured = parseObservabilityDb(await readFile(configPath, 'utf8'))
      if (configured) return isAbsolute(configured) ? configured : resolve(root, configured)
    } catch { /* default */ }
    return resolve(root, DEFAULT_DB)
  }

  private async bun(): Promise<string> {
    return this.bunOverride ?? await resolveBunExecutable()
  }

  private trackHealthAbort(root: string, controller: AbortController): void {
    let set = this.healthAborts.get(root)
    if (!set) {
      set = new Set()
      this.healthAborts.set(root, set)
    }
    set.add(controller)
  }

  private untrackHealthAbort(root: string, controller: AbortController): void {
    const set = this.healthAborts.get(root)
    if (!set) return
    set.delete(controller)
    if (set.size === 0) this.healthAborts.delete(root)
  }

  private abortHealth(root: string): void {
    const set = this.healthAborts.get(root)
    if (!set) return
    for (const controller of set) controller.abort()
    this.healthAborts.delete(root)
  }

  private abortAllHealth(): void {
    for (const set of this.healthAborts.values()) for (const controller of set) controller.abort()
    this.healthAborts.clear()
  }

  private async waitForHealth(port: number, child: ChildProcess, root: string, generation: number): Promise<void> {
    const deadline = this.now() + HEALTH_TIMEOUT_MS
    while (this.now() < deadline) {
      if (!this.owns(root, generation) || this.closed) throw new Error('Factory manager is shutting down')
      if (!isChildAlive(child)) throw new Error('Factory watch-screen exited unexpectedly')
      const remaining = deadline - this.now()
      if (remaining <= 0) break
      const controller = new AbortController()
      this.trackHealthAbort(root, controller)
      const timer = setTimeout(() => controller.abort(), remaining)
      timer.unref()
      try {
        const response = await this.fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
        if (response.status === 200) return
      } catch {
        if (!this.owns(root, generation) || this.closed) throw new Error('Factory manager is shutting down')
        if (this.now() >= deadline) break
      } finally {
        clearTimeout(timer)
        this.untrackHealthAbort(root, controller)
      }
      await this.delayFn(HEALTH_POLL_MS)
    }
    throw new Error('Factory watch-screen did not become ready')
  }

  private async killChild(child: ChildProcess): Promise<void> {
    if (!child.pid) {
      try { child.kill('SIGTERM') } catch { /* already exited */ }
      return
    }
    await killProcessTree(child.pid, {
      ladder: [{ signal: 'SIGTERM', waitMs: 1_000 }, { signal: 'SIGKILL', waitMs: 1_500 }],
      hasExited: () => !isChildAlive(child),
      waitForExit: (timeoutMs) => waitForProcessExit(child, timeoutMs),
      signalDirect: (signal) => { try { child.kill(signal) } catch { /* already exited */ } },
    })
  }

  private async boot(root: string, generation: number, previousChild?: ChildProcess): Promise<void> {
    if (previousChild) await this.killChild(previousChild)
    if (!this.owns(root, generation)) return
    if (!(await this.detect(root))) {
      if (this.owns(root, generation)) {
        const current = this.entries.get(root)
        if (current?.generation === generation && current.state === 'starting') this.entries.delete(root)
      }
      return
    }
    if (!this.owns(root, generation)) return

    let entry = this.entries.get(root)
    if (!entry || entry.generation !== generation) {
      entry = { port: 0, state: 'starting', generation }
      this.entries.set(root, entry)
    }

    let child: ChildProcess | undefined
    try {
      const visualizer = join(root, '.claude', 'skills', 'sssf', 'apps', 'visualizer')
      if (!(await directoryExists(visualizer))) throw new Error('Factory visualizer is missing')
      if (!this.owns(root, generation, entry)) return

      if (!(await directoryExists(join(visualizer, 'dist')))) {
        if (!this.owns(root, generation, entry)) return
        entry.state = 'installing'
        const bun = await this.bun()
        if (!this.owns(root, generation, entry)) return
        const install = await this.runProcessFn(bun, ['install'], { cwd: visualizer, timeoutMs: INSTALL_TIMEOUT_MS })
        if (!this.owns(root, generation, entry)) return
        const installError = processFailed(install, 'bun install')
        if (installError) throw new Error(installError)
        const build = await this.runProcessFn(bun, ['run', 'build'], { cwd: visualizer, timeoutMs: BUILD_TIMEOUT_MS })
        if (!this.owns(root, generation, entry)) return
        const buildError = processFailed(build, 'bun run build')
        if (buildError) throw new Error(buildError)
      }

      if (!this.owns(root, generation, entry)) return
      entry.state = 'starting'
      const db = await this.resolveDb(root)
      if (!this.owns(root, generation, entry)) return
      const port = await this.allocatePortFn()
      if (!this.owns(root, generation, entry)) return
      entry.port = port
      entry.url = `http://127.0.0.1:${port}`

      const bun = await this.bun()
      if (!this.owns(root, generation, entry)) return

      const options: SpawnOptions = {
        cwd: visualizer,
        env: safeChildEnvironment({ SSSF_DB: db, PORT: String(port) }),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32',
      }
      child = this.spawnFn(bun, ['run', 'server/index.ts'], options)
      entry.child = child
      registerChildProcess(child)
      child.once('close', () => {
        if (!this.owns(root, generation, entry)) return
        if (entry.state === 'running' || entry.state === 'starting' || entry.state === 'installing') {
          entry.state = 'error'
          entry.message = 'Factory watch-screen exited unexpectedly'
        }
      })
      child.once('error', (error) => {
        if (!this.owns(root, generation, entry)) return
        entry.state = 'error'
        entry.message = error instanceof Error ? error.message : String(error)
      })

      await this.waitForHealth(port, child, root, generation)
      if (!this.owns(root, generation, entry)) return
      if (!isChildAlive(child)) throw new Error('Factory watch-screen exited unexpectedly')
      entry.state = 'running'
    } catch (error) {
      if (this.owns(root, generation, entry)) {
        entry.state = 'error'
        entry.message = error instanceof Error ? error.message : String(error)
      }
    } finally {
      // Ownership loss means do not touch the shared entry. The disowned boot
      // still owns its child and must tear it down so the port is released.
      if (child && (!this.owns(root, generation, entry) || entry.state === 'error')) {
        await this.killChild(child)
      }
    }
  }
}
