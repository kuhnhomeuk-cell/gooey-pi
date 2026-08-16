import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const BRIDGE_FILES = {
  browser: 'electron/main/browser/agent-bridge.ts',
  schedule: 'electron/main/schedules/agent-bridge.ts',
  collaboration: 'electron/main/collaboration/agent-bridge.ts',
} as const

type BridgeName = keyof typeof BRIDGE_FILES

/**
 * Capability methods each bridge dispatches, and the harness assets that must
 * advertise the same names. Prime schedules live in the Python skill; OMP and
 * pi share the TypeScript schedule extension. Ask-user and fast-mode have no
 * matching bridge (ask-user uses the host UI select API; fast-mode is a slash
 * command), so they are not rows here.
 */
const CONTRACTS: Array<{ bridge: BridgeName; assets: string[]; methods: string[] }> = [
  {
    bridge: 'browser',
    assets: [
      'assets/extensions/prime-work-browser.ts',
      'assets/extensions/omp-work-browser.ts',
    ],
    methods: [
      'terminal.read',
      'tabs.list',
      'tabs.open',
      'tabs.close',
      'tabs.select',
      'navigate',
      'screenshot',
      'click',
      'type',
      'press_key',
      'scroll',
      'read_page',
      'evaluate',
    ],
  },
  {
    bridge: 'schedule',
    assets: [
      'assets/extensions/omp-work-schedules.ts',
      'assets/skills/prime-work-schedules/src/prime_work_schedules/__init__.py',
    ],
    methods: ['list', 'create', 'pause', 'resume', 'delete', 'run_now', 'update'],
  },
  {
    bridge: 'collaboration',
    assets: ['assets/extensions/omp-work-collaboration.ts'],
    methods: ['list', 'models', 'create', 'wait', 'read', 'send'],
  },
]

const ROWS = CONTRACTS.flatMap(({ bridge, assets, methods }) => (
  methods.flatMap((method) => assets.map((asset) => ({ method, bridge, asset })))
))

function sourceOf(path: string): string {
  return readFileSync(path, 'utf8')
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function bridgeMethods(path: string): string[] {
  return sortedUnique([...sourceOf(path).matchAll(/method === ['"]([^'"]+)['"]/g)].map((match) => match[1]))
}

function advertisedMethods(path: string): string[] {
  const source = sourceOf(path)
  const methods = new Set<string>()
  for (const match of source.matchAll(/\b(?:call|_call)\(\s*(['"])([^'"]+)\1/g)) methods.add(match[2])
  for (const match of source.matchAll(/\b(?:call|_call)\(\s*params\.(\w+)/g)) {
    const param = match[1]
    for (const enumMatch of source.matchAll(new RegExp(`${param}:\\s*(?:Type\\.Enum|StringEnum)\\(\\s*\\[([^\\]]+)\\]`, 'g'))) {
      for (const value of enumMatch[1].matchAll(/['"]([^'"]+)['"]/g)) methods.add(value[1])
    }
  }
  return sortedUnique(methods)
}

describe('extension contract parity', () => {
  it.each(ROWS)('$method is handled by the $bridge bridge and advertised in $asset', ({ method, bridge, asset }) => {
    expect(bridgeMethods(BRIDGE_FILES[bridge])).toContain(method)
    expect(advertisedMethods(asset)).toContain(method)
  })

  it.each(CONTRACTS)('every $bridge method exists in each asset, and every advertised asset method exists on $bridge', ({ bridge, assets, methods }) => {
    const expected = sortedUnique(methods)
    expect(bridgeMethods(BRIDGE_FILES[bridge])).toEqual(expected)
    for (const asset of assets) expect(advertisedMethods(asset)).toEqual(expected)
  })

  it('ask-user and fast-mode do not advertise a capability-bridge method contract', () => {
    expect(advertisedMethods('assets/extensions/omp-work-ask-user.ts')).toEqual([])
    expect(advertisedMethods('assets/extensions/pi-work-fast-mode.ts')).toEqual([])
  })
})
