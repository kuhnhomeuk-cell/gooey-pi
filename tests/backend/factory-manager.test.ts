import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { allocateEphemeralPort, FactoryManager, parseObservabilityDb } from '../../electron/main/factory-manager'
import type { ProcessResult } from '../../electron/main/process-utils'
import type { FactoryStatus } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'gooey-factory-')); dirs.push(dir); return dir }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function okProcess(): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputExceeded: false, stdoutBytes: 0, stderrBytes: 0 }
}

function failedProcess(stderr: string): ProcessResult {
  return { code: 1, signal: null, stdout: '', stderr, timedOut: false, outputExceeded: false, stdoutBytes: 0, stderrBytes: Buffer.byteLength(stderr) }
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null }
  Object.assign(child, { pid: 4242, exitCode: null, signalCode: null })
  child.kill = ((signal?: NodeJS.Signals) => {
    Object.assign(child, { exitCode: signal === 'SIGKILL' ? 1 : 0 })
    child.emit('close', child.exitCode, signal ?? null)
    return true
  }) as ChildProcess['kill']
  return child
}

function factoryProject(options: { db?: string; dist?: boolean } = {}) {
  const root = temp()
  mkdirSync(join(root, 'adws', 'adw_sssf_config'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills', 'sssf', 'apps', 'visualizer', options.dist === false ? '' : 'dist'), { recursive: true })
  if (options.db) {
    writeFileSync(join(root, 'adws', 'adw_sssf_config', 'sssf.config.yaml'), `observability:\n  db: ${options.db}\n`)
  }
  return root
}

function readyFetch(): typeof fetch {
  return (async () => new Response('ok', { status: 200 })) as typeof fetch
}

async function waitForStatus(manager: FactoryManager, root: string, predicate: (status: FactoryStatus) => boolean): Promise<FactoryStatus> {
  const deadline = Date.now() + 5_000
  let status = await manager.status(root)
  while (!predicate(status)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for status, last=${JSON.stringify(status)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    status = await manager.status(root)
  }
  return status
}

function abortableFetch(onStart?: (signal: AbortSignal) => void): { fetch: typeof fetch; resolve: (response: Response) => void } {
  const waiters: Array<{ resolve: (response: Response) => void; reject: (error: unknown) => void }> = []
  return {
    fetch: (async (_url, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('health fetch is missing an AbortSignal')
      onStart?.(signal)
      return await new Promise<Response>((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) return fail()
        signal.addEventListener('abort', fail, { once: true })
        waiters.push({ resolve, reject })
      })
    }) as typeof fetch,
    resolve: (response: Response) => {
      for (const waiter of waiters.splice(0)) waiter.resolve(response)
    },
  }
}

describe('parseObservabilityDb', () => {
  it('reads nested and dotted observability.db values', () => {
    expect(parseObservabilityDb('observability:\n  enabled: true\n  db: adws/custom.db\n')).toBe('adws/custom.db')
    expect(parseObservabilityDb('observability.db: "/abs/sssf.db"\n')).toBe('/abs/sssf.db')
  })
})

describe('FactoryManager', () => {
  it('reports none when the factory is not installed', async () => {
    const root = temp()
    const manager = new FactoryManager()
    await expect(manager.detect(root)).resolves.toBe(false)
    await expect(manager.ensure(root)).resolves.toEqual({ state: 'none' })
    await expect(manager.status(root)).resolves.toEqual({ state: 'none' })
  })

  it('reuses one live server and never double-spawns', async () => {
    const root = factoryProject()
    const spawned: Array<{ file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = []
    const child = fakeChild()
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4611,
      fetch: readyFetch(),
      delay: async () => undefined,
      spawn: ((file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawned.push({ file, args, env: options.env })
        return child
      }) as typeof import('node:child_process').spawn,
    })

    const [first, second] = await Promise.all([manager.ensure(root), manager.ensure(root)])
    expect(first.state === 'starting' || first.state === 'running').toBe(true)
    expect(second.state === 'starting' || second.state === 'running').toBe(true)

    await waitUntil(() => spawned.length > 0)
    await expect(manager.status(root)).resolves.toEqual({ state: 'running', url: 'http://127.0.0.1:4611' })
    await expect(manager.ensure(root)).resolves.toEqual({ state: 'running', url: 'http://127.0.0.1:4611' })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ file: '/usr/local/bin/bun', args: ['run', 'server/index.ts'] })
    expect(spawned[0]?.env?.PORT).toBe('4611')
    expect(spawned[0]?.env?.SSSF_DB).toBe(join(realpathSync(root), 'adws', 'adw_data', 'sssf.db'))
    await manager.stopAll()
  })

  it('spawns once and allocates one port across canonical aliases', async () => {
    const root = factoryProject()
    const alias = join(temp(), 'alias')
    symlinkSync(root, alias)
    const spawned: ChildProcess[] = []
    const ports: number[] = []
    const gate = deferred<void>()
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => {
        ports.push(4701)
        await gate.promise
        return 4701
      },
      fetch: readyFetch(),
      delay: async () => undefined,
      spawn: (() => {
        const child = fakeChild()
        spawned.push(child)
        return child
      }) as typeof import('node:child_process').spawn,
    })

    const first = manager.ensure(root)
    const second = manager.ensure(alias)
    await waitUntil(() => ports.length > 0)
    gate.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(a.state === 'starting' || a.state === 'running').toBe(true)
    expect(b.state === 'starting' || b.state === 'running').toBe(true)
    await waitUntil(() => spawned.length > 0)
    await expect(manager.status(alias)).resolves.toEqual({ state: 'running', url: 'http://127.0.0.1:4701' })
    await expect(manager.ensure(root)).resolves.toEqual({ state: 'running', url: 'http://127.0.0.1:4701' })
    expect(ports).toHaveLength(1)
    expect(spawned).toHaveLength(1)
    expect(spawned.filter((child) => child.exitCode === null)).toHaveLength(1)
    await manager.stopAll()
  })

  it('returns starting immediately when retrying from error', async () => {
    const root = factoryProject()
    let attempts = 0
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4613,
      fetch: readyFetch(),
      delay: async () => undefined,
      spawn: (() => {
        attempts += 1
        const child = fakeChild()
        if (attempts === 1) {
          queueMicrotask(() => {
            Object.assign(child, { exitCode: 1 })
            child.emit('close', 1, null)
          })
        }
        return child
      }) as typeof import('node:child_process').spawn,
    })

    await manager.ensure(root)
    await waitForStatus(manager, root, (status) => status.state === 'error')
    expect(await manager.status(root)).toMatchObject({ state: 'error' })

    const retry = await manager.ensure(root)
    expect(retry).toEqual({ state: 'starting' })
    await waitForStatus(manager, root, (status) => status.state === 'running')
    await expect(manager.status(root)).resolves.toEqual({ state: 'running', url: 'http://127.0.0.1:4613' })
    expect(attempts).toBe(2)
    await manager.stopAll()
  })

  it('does not double-spawn when stop and ensure overlap a delayed boot', async () => {
    const root = factoryProject()
    const signals: AbortSignal[] = []
    const children: ChildProcess[] = []
    const ports: number[] = []
    let port = 4800
    const health = abortableFetch((signal) => { signals.push(signal) })
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => {
        port += 1
        ports.push(port)
        return port
      },
      delay: async () => undefined,
      fetch: health.fetch,
      spawn: (() => {
        const child = fakeChild()
        children.push(child)
        return child
      }) as typeof import('node:child_process').spawn,
    })

    const first = manager.ensure(root)
    await waitUntil(() => children.length === 1 && signals.length === 1)
    const stop = manager.stop(root)
    await waitUntil(() => signals[0]?.aborted === true)
    const second = manager.ensure(root)
    await waitUntil(() => children.length === 2)
    health.resolve(new Response('ok', { status: 200 }))
    await Promise.all([first, stop, second])
    await waitForStatus(manager, root, (status) => status.state === 'running')
    expect(children.filter((child) => child.exitCode === null)).toHaveLength(1)
    expect(ports).toHaveLength(2)
    expect(signals.some((signal) => signal.aborted)).toBe(true)
    await expect(manager.status(root)).resolves.toEqual({ state: 'running', url: `http://127.0.0.1:${ports[1]}` })
    await manager.stopAll()
  })

  it('runs bounded bun install then build before spawn when dist is missing', async () => {
    const root = factoryProject({ dist: false })
    const processes: Array<{ args: readonly string[]; timeoutMs?: number }> = []
    const spawned: string[] = []
    const installGate = deferred<void>()
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4614,
      fetch: readyFetch(),
      delay: async () => undefined,
      runProcess: (async (_file, args, options) => {
        processes.push({ args, timeoutMs: options?.timeoutMs })
        if (args[0] === 'install') await installGate.promise
        return okProcess()
      }) as typeof import('../../electron/main/process-utils').runProcess,
      spawn: (() => {
        spawned.push('server')
        return fakeChild()
      }) as typeof import('node:child_process').spawn,
    })

    const ensuring = manager.ensure(root)
    await waitUntil(() => processes.length === 1)
    expect(processes[0]).toEqual({ args: ['install'], timeoutMs: 120_000 })
    expect(spawned).toHaveLength(0)
    await expect(manager.status(root)).resolves.toEqual({ state: 'installing' })
    installGate.resolve()
    await ensuring
    await waitUntil(() => spawned.length === 1)
    expect(processes.map((step) => step.args)).toEqual([['install'], ['run', 'build']])
    expect(processes[1]?.timeoutMs).toBe(180_000)
    expect(spawned).toHaveLength(1)
    await expect(manager.status(root)).resolves.toEqual({ state: 'running', url: 'http://127.0.0.1:4614' })
    await manager.stopAll()
  })

  it('does not build or spawn when bun install fails', async () => {
    const root = factoryProject({ dist: false })
    const processes: Array<readonly string[]> = []
    let spawned = 0
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4615,
      fetch: readyFetch(),
      delay: async () => undefined,
      runProcess: (async (_file, args) => {
        processes.push(args)
        return failedProcess('install exploded')
      }) as typeof import('../../electron/main/process-utils').runProcess,
      spawn: (() => {
        spawned += 1
        return fakeChild()
      }) as typeof import('node:child_process').spawn,
    })

    await manager.ensure(root)
    await waitForStatus(manager, root, (status) => status.state === 'error')
    expect(processes).toEqual([['install']])
    expect(spawned).toBe(0)
    await expect(manager.status(root)).resolves.toEqual({ state: 'error', message: 'install exploded' })
    await manager.stopAll()
  })

  it('records spawn failure and releases the boot so retry can start again', async () => {
    const root = factoryProject()
    let attempts = 0
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4616,
      fetch: readyFetch(),
      delay: async () => undefined,
      spawn: (() => {
        attempts += 1
        if (attempts === 1) throw new Error('spawn ENOENT')
        return fakeChild()
      }) as typeof import('node:child_process').spawn,
    })

    await manager.ensure(root)
    await waitForStatus(manager, root, (status) => status.state === 'error')
    await expect(manager.status(root)).resolves.toEqual({ state: 'error', message: 'spawn ENOENT' })

    const retry = await manager.ensure(root)
    expect(retry.state === 'starting' || retry.state === 'running').toBe(true)
    await waitForStatus(manager, root, (status) => status.state === 'running')
    expect(attempts).toBe(2)
    await manager.stopAll()
  })

  it('records an async child error while boot is in flight and allows retry', async () => {
    const root = factoryProject()
    const ports: number[] = []
    const children: ChildProcess[] = []
    const firstKillSignals: NodeJS.Signals[] = []
    const firstHealthSignals: AbortSignal[] = []
    let holder: Server | undefined
    let holderListening: Promise<void> = Promise.resolve()
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => {
        if (ports.length === 0) {
          const port = await allocateEphemeralPort()
          ports.push(port)
          return port
        }
        const released = ports[0]
        expect(released).toBeTypeOf('number')
        await new Promise<void>((resolve, reject) => {
          const probe = createServer()
          probe.once('error', reject)
          probe.listen(released, '127.0.0.1', () => {
            probe.close((error) => { if (error) reject(error); else resolve() })
          })
        })
        ports.push(released!)
        return released!
      },
      delay: async () => undefined,
      fetch: ((url, init) => {
        const port = Number(new URL(String(url)).port)
        const first = children[0]
        const firstStillAlive = first != null && first.exitCode === null && first.signalCode === null
        if (firstStillAlive && port === ports[0]) {
          const signal = init?.signal
          if (!signal) return Promise.reject(new Error('health fetch is missing an AbortSignal'))
          firstHealthSignals.push(signal)
          return new Promise<Response>((_resolve, reject) => {
            const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (signal.aborted) return fail()
            signal.addEventListener('abort', fail, { once: true })
          })
        }
        return Promise.resolve(new Response('ok', { status: 200 }))
      }) as typeof fetch,
      spawn: ((_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as ChildProcess & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null }
        Object.assign(child, { pid: 4_242 + children.length, exitCode: null, signalCode: null })
        children.push(child)
        if (children.length === 1) {
          const port = Number(options.env?.PORT)
          const server = createServer()
          holder = server
          holderListening = new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, '127.0.0.1', resolve)
          })
          child.kill = ((signal?: NodeJS.Signals) => {
            const delivered = signal ?? 'SIGTERM'
            firstKillSignals.push(delivered)
            const finish = (): void => {
              if (child.exitCode !== null || child.signalCode !== null) return
              Object.assign(child, { exitCode: 0, signalCode: delivered })
              child.emit('exit', 0, delivered)
              child.emit('close', 0, delivered)
            }
            if (!holder) {
              finish()
              return true
            }
            holder.close(() => {
              holder = undefined
              finish()
            })
            return true
          }) as ChildProcess['kill']
          queueMicrotask(() => {
            child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
          })
        } else {
          child.kill = ((signal?: NodeJS.Signals) => {
            Object.assign(child, { exitCode: signal === 'SIGKILL' ? 1 : 0 })
            child.emit('close', child.exitCode, signal ?? null)
            return true
          }) as ChildProcess['kill']
        }
        return child
      }) as typeof import('node:child_process').spawn,
    })

    const first = manager.ensure(root)
    await waitUntil(() => children.length === 1)
    await holderListening
    await waitForStatus(manager, root, (status) => status.state === 'error')
    await expect(manager.status(root)).resolves.toEqual({ state: 'error', message: 'spawn EACCES' })
    expect(ports).toHaveLength(1)
    expect(children[0]?.exitCode).toBeNull()
    expect(children[0]?.signalCode).toBeNull()
    expect(firstKillSignals).toEqual([])

    const retry = await manager.ensure(root)
    expect(retry).toEqual({ state: 'starting' })
    expect(firstKillSignals).toEqual(['SIGTERM'])
    expect(children[0]?.exitCode !== null || children[0]?.signalCode !== null).toBe(true)
    await waitUntil(() => children.length === 2 && ports.length === 2)
    expect(firstHealthSignals.some((signal) => signal.aborted)).toBe(true)
    await first
    await waitForStatus(manager, root, (status) => status.state === 'running')
    await expect(manager.status(root)).resolves.toEqual({ state: 'running', url: `http://127.0.0.1:${ports[1]}` })
    expect(children).toHaveLength(2)
    expect(ports[0]).toBe(ports[1])
    await manager.stopAll()
  })

  it('aborts a hanging health fetch when stop is called', async () => {
    const root = factoryProject()
    const signals: AbortSignal[] = []
    const health = abortableFetch((signal) => { signals.push(signal) })
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4617,
      delay: async () => undefined,
      fetch: health.fetch,
      spawn: (() => fakeChild()) as typeof import('node:child_process').spawn,
    })

    const ensuring = manager.ensure(root)
    await waitUntil(() => signals.length === 1)
    expect(signals[0]?.aborted).toBe(false)
    await Promise.race([
      manager.stop(root),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('stop() hung on health fetch')), 500)),
    ])
    await ensuring
    expect(signals[0]?.aborted).toBe(true)
    await expect(manager.status(root)).resolves.toEqual({ state: 'none' })
    await manager.stopAll()
  })

  it('aborts a hanging health fetch when the remaining deadline elapses', async () => {
    const root = factoryProject()
    const signals: AbortSignal[] = []
    let nowCalls = 0
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      now: () => {
        nowCalls += 1
        if (nowCalls <= 2) return 0
        if (nowCalls === 3) return 29_990
        return 30_000
      },
      allocatePort: async () => 4618,
      delay: async () => undefined,
      fetch: abortableFetch((signal) => { signals.push(signal) }).fetch,
      spawn: (() => fakeChild()) as typeof import('node:child_process').spawn,
    })

    const ensuring = manager.ensure(root)
    await waitUntil(() => signals.length === 1)
    await waitUntil(() => signals[0]?.aborted === true, 1_000)
    await ensuring
    const status = await waitForStatus(manager, root, (next) => next.state === 'error')
    expect(status.message).toBe('Factory watch-screen did not become ready')
    await manager.stopAll()
  })

  it('resolves observability.db against the project root', async () => {
    const root = factoryProject({ db: 'adws/custom/obs.db' })
    let db: string | undefined
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4612,
      fetch: readyFetch(),
      delay: async () => undefined,
      spawn: ((_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        db = options.env?.SSSF_DB
        return fakeChild()
      }) as typeof import('node:child_process').spawn,
    })
    await manager.ensure(root)
    await waitUntil(() => db !== undefined)
    expect(db).toBe(join(realpathSync(root), 'adws', 'custom', 'obs.db'))
    await manager.stopAll()
  })
})
