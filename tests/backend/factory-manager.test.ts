import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { FactoryManager, parseObservabilityDb } from '../../electron/main/factory-manager'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'gooey-factory-')); dirs.push(dir); return dir }

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
      fetch: (async () => new Response('ok', { status: 200 })) as typeof fetch,
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

  it('resolves observability.db against the project root', async () => {
    const root = factoryProject({ db: 'adws/custom/obs.db' })
    let db: string | undefined
    const manager = new FactoryManager({
      bun: '/usr/local/bin/bun',
      allocatePort: async () => 4612,
      fetch: (async () => new Response('ok', { status: 200 })) as typeof fetch,
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
