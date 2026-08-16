import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { LEGACY_DESKTOP_STATE_FILENAME } from '../../../electron/main/store'

export { test, expect, electron }

export let app: ElectronApplication | undefined
export let page: Page
export let fixtureRoot = ''
export let fixtureSessionFile = ''
export let currentFixture: ReturnType<typeof createHermeticFixture> | undefined
export let actionableErrors: string[] = []

const instrumentedPages = new WeakSet<Page>()

const attachDiagnostics = (target: Page) => {
  if (instrumentedPages.has(target)) return
  instrumentedPages.add(target)
  target.on('pageerror', (error) => actionableErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') actionableErrors.push(message.text())
  })
}

export async function closeHermeticApp(target: ElectronApplication | undefined): Promise<void> {
  if (!target) return
  const child = target.process()
  const closeEvent = target.waitForEvent('close', { timeout: 15_000 }).then(() => undefined, () => undefined)
  const gracefulClose = target.close().then(() => true, () => false)
  const closedGracefully = await Promise.race([
    gracefulClose,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (closedGracefully) return
  if (child.exitCode === null) child.kill('SIGKILL')
  await closeEvent
}

interface CapturedClosePrompt {
  message: string
  detail?: string
  buttons: string[]
}

/** Records the async close confirmations and answers Cancel until `__closeResponse` says otherwise. */
export async function stubCloseDialog(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ dialog }) => {
    const scope = globalThis as { __closePrompts?: unknown[]; __closeResponse?: number }
    scope.__closePrompts = []
    scope.__closeResponse = 0
    const closeDialog = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<{ response: number }> }
    closeDialog.showMessageBox = (...args) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string; detail?: string; buttons?: string[] }
      scope.__closePrompts?.push({ message: options.message, detail: options.detail, buttons: options.buttons ?? [] })
      return Promise.resolve({ response: scope.__closeResponse ?? 0 })
    }
  })
}

export function closePrompts(target: ElectronApplication): Promise<CapturedClosePrompt[]> {
  return target.evaluate(() => (globalThis as { __closePrompts?: unknown[] }).__closePrompts ?? []) as Promise<CapturedClosePrompt[]>
}

function createHermeticFixture(activeSession = false): { userData: string; home: string; project: string; executable: string; ompExecutable: string; piExecutable: string; cuaExecutable: string; sessionFile: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'prime-work-e2e-'))
  const userData = join(fixtureRoot, 'user-data')
  const home = join(fixtureRoot, 'home')
  const project = join(fixtureRoot, 'project')
  const secondary = join(fixtureRoot, 'secondary-project')
  const sessions = join(home, '.prime', 'agent', 'sessions')
  mkdirSync(userData, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(secondary, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const canonicalProject = realpathSync(project)
  const canonicalSecondary = realpathSync(secondary)
  const initializeRepository = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), 'base\n')
    for (const args of [
      ['init', '-q'],
      ['config', 'user.name', 'Prime Work E2E'],
      ['config', 'user.email', 'e2e@example.com'],
      ['add', file],
      ['commit', '-qm', 'base'],
    ]) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
  }
  initializeRepository(project, 'primary.txt')
  initializeRepository(secondary, 'secondary-change.txt')
  writeFileSync(join(secondary, 'secondary-change.txt'), 'base\nsecondary workspace change\n')
  writeFileSync(join(project, 'README.md'), '# Hermetic Prime Work fixture\n')
  const ompSessions = join(home, '.omp', 'agent', 'sessions', '-omp-project')
  mkdirSync(ompSessions, { recursive: true })
  const ompTitleUnpadded = JSON.stringify({ type: 'title', v: 1, title: 'OMP hermetic fixture', updatedAt: '2026-02-01T00:00:00.000Z', pad: '' })
  const ompTitleSlot = JSON.stringify({ type: 'title', v: 1, title: 'OMP hermetic fixture', updatedAt: '2026-02-01T00:00:00.000Z', pad: ' '.repeat(256 - 1 - Buffer.byteLength(ompTitleUnpadded, 'utf8')) })
  const ompSessionFile = join(ompSessions, '2026-02-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000001.jsonl')
  writeFileSync(ompSessionFile, [
    ompTitleSlot,
    JSON.stringify({ type: 'session', version: 3, id: '019fdf24-aaaa-7000-8000-000000000001', timestamp: '2026-02-01T00:00:00.000Z', cwd: canonicalProject }),
    JSON.stringify({ type: 'message', id: 'omp-user', parentId: null, timestamp: '2026-02-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'OMP hermetic fixture' }], timestamp: 1774915201000 } }),
    JSON.stringify({ type: 'message', id: 'omp-assistant', parentId: 'omp-user', timestamp: '2026-02-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'OMP fixture reply.' }] } }),
    '',
  ].join('\n'))
  const piSessions = join(home, '.pi', 'agent', 'sessions', '--pi-project--')
  mkdirSync(piSessions, { recursive: true })
  const piSessionFile = join(piSessions, '2026-03-01T00-00-00-000Z_019fdf24-bbbb-7000-8000-000000000002.jsonl')
  writeFileSync(piSessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: '019fdf24-bbbb-7000-8000-000000000002', timestamp: '2026-03-01T00:00:00.000Z', cwd: canonicalProject }),
    JSON.stringify({ type: 'session_info', id: 'pi-info', parentId: null, timestamp: '2026-03-01T00:00:00.500Z', name: 'Pi hermetic fixture' }),
    JSON.stringify({ type: 'message', id: 'pi-user', parentId: 'pi-info', timestamp: '2026-03-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Pi hermetic fixture' }], timestamp: 1777341601000 } }),
    JSON.stringify({ type: 'message', id: 'pi-assistant', parentId: 'pi-user', timestamp: '2026-03-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi fixture reply.' }] } }),
    '',
  ].join('\n'))
  const sessionFile = join(sessions, 'fixture.jsonl')
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'fixture-session', cwd: canonicalSecondary, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'fixture-message', parentId: null, message: { role: 'user', content: [
      { type: 'text', text: 'Hermetic desktop fixture' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
    ], timestamp: '2026-01-01T00:00:00.000Z' } }),
    JSON.stringify({
      type: 'custom_message', id: 'fixture-agent-message', parentId: 'fixture-message', customType: 'agent_message', display: true,
      content: '[from child:fixture-reviewer]\nAgent-to-agent message received.\n\nEnvelope metadata that should stay hidden.',
      details: { message: 'Fixture review complete. The readable agent response is available here.', from: { sessionName: 'fixture-reviewer', runtimeKind: 'subagent' } },
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    JSON.stringify({
      type: 'custom_message', id: 'fixture-goal-summary', parentId: 'fixture-agent-message', customType: 'goal_context', display: true,
      content: '<goal_context>Fixture control envelope that should stay hidden.</goal_context>',
      details: { kind: 'created', goalId: 'fixture-goal', objective: 'Verify the readable blue goal summary.', status: 'active', continuationsUsed: 0 },
      timestamp: '2026-01-01T00:00:02.000Z',
    }),
    '',
  ].join('\n'))
  writeFileSync(join(sessions, 'primary.jsonl'), [
    JSON.stringify({ type: 'session', id: 'primary-session', cwd: canonicalProject, timestamp: '2025-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'primary-message', parentId: null, message: { role: 'user', content: 'Primary workspace fixture', timestamp: '2025-01-01T00:00:00.000Z' } }),
    '',
  ].join('\n'))
  writeFileSync(join(sessions, 'collaboration-peer.jsonl'), [
    JSON.stringify({ type: 'session', id: '019fdf24-cccc-7000-8000-000000000003', cwd: canonicalSecondary, timestamp: '2024-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'collaboration-peer-message', parentId: null, message: { role: 'user', content: 'Ownership peer fixture', timestamp: '2024-01-01T00:00:00.000Z' } }),
    '',
  ].join('\n'))
  const identity = (path: string) => {
    const info = lstatSync(path, { bigint: true })
    return {
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : undefined,
    }
  }
  writeFileSync(join(userData, LEGACY_DESKTOP_STATE_FILENAME), JSON.stringify({
    version: 1,
    projects: [{
      id: 'multi-folder-project', name: 'Multi-folder fixture', path: canonicalProject,
      folders: [canonicalProject, canonicalSecondary], primaryFolder: canonicalProject,
      pinned: false, createdAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
      folderIdentities: { [canonicalProject]: identity(canonicalProject), [canonicalSecondary]: identity(canonicalSecondary) },
    }],
    settings: { activeHarness: 'prime', browserHome: 'about:blank', telemetry: true },
    archivedSessions: [],
    dismissedProjectPaths: [],
  }))

  const daemonExecutable = join(fixtureRoot, 'prime-agent-daemon-fixture.cjs')
  writeFileSync(daemonExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const socketPath = ${JSON.stringify(join(fixtureRoot, 'daemon.sock'))}
try { fs.unlinkSync(socketPath) } catch {}
const server = net.createServer((socket) => {
  socket.write(JSON.stringify({ type: 'daemon_hello', protocol: { name: 'prime-agent.daemon', version: 7 }, serverCapabilities: ['session_input_admission'] }) + '\\n')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\\n')) {
      const index = buffer.indexOf('\\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const envelope = JSON.parse(line)
      if (envelope.command?.type === 'ack_result') {
        fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'follow-up-ack.json'))}, JSON.stringify(envelope.command))
        continue
      }
      if (envelope.command?.type !== 'follow_up') continue
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'follow-up-args.json'))}, JSON.stringify(envelope.command))
      const timestamp = new Date().toISOString()
      fs.appendFileSync(${JSON.stringify(sessionFile)}, [
        JSON.stringify({ type: 'message', id: 'fixture-external-user', parentId: 'fixture-goal-summary', timestamp, message: { role: 'user', content: envelope.command.message } }),
        JSON.stringify({ type: 'message', id: 'fixture-external-assistant', parentId: 'fixture-external-user', timestamp, message: { role: 'assistant', content: 'The external Prime Agent received the queued reply.' } }),
      ].join('\\n') + '\\n')
      socket.write(JSON.stringify({ id: envelope.id, type: 'response', command: 'follow_up', success: true, data: {} }) + '\\n')
    }
  })
  socket.on('end', () => server.close())
})
server.listen(socketPath)
setTimeout(() => server.close(), 30_000).unref()
`)
  chmodSync(daemonExecutable, 0o755)

  const executable = join(fixtureRoot, 'prime-agent-fixture.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('prime-agent 0.7.0\\n'); process.exit(0) }
if (args[0] === 'schedule') { process.stdout.write(JSON.stringify({ jobs: [] }) + '\\n'); process.exit(0) }
const resumeIndex = args.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(realpathSync(sessionFile))}
if (args[0] === 'list') {
  const sessions = ${JSON.stringify(activeSession)}
    ? [{ id: 'active-fixture', activeSessionId: 'active-fixture', lifecycle: 'live', isSessionActive: true, activity: 'working', isStreaming: true, sessionFile, modified: new Date().toISOString() }]
    : []
  process.stdout.write(JSON.stringify({ sessions }) + '\\n')
  process.exit(0)
}
if (args[0] === 'status') {
  const { spawn } = require('node:child_process')
  if (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))})) {
    const child = spawn(process.execPath, [${JSON.stringify(join(fixtureRoot, 'prime-agent-daemon-fixture.cjs'))}], { detached: true, stdio: 'ignore' })
    child.unref()
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 3_000
    while (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))}) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20)
  }
  if (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))})) process.exit(2)
  process.stdout.write(JSON.stringify([{ isDefault: true, status: 'current', socketPath: ${JSON.stringify(join(fixtureRoot, 'daemon.sock'))} }]) + '\\n')
  process.exit(0)
}
fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prime-runtime-args.json'))}, JSON.stringify(args))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let pendingPrompt
let streaming = false
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionId: 'fixture-session', sessionFile, isStreaming: streaming, thinkingLevel: 'medium', model: { provider: 'fixture', id: 'fixture-model', name: 'Fixture Model' } } })
  } else if (command.type === 'get_session_stats') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 } } })
  } else if (command.type === 'list_schedules') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { jobs: [] } })
  } else if (command.type === 'steer') {
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'steer-args.json'))}, JSON.stringify(command))
    setTimeout(() => send({ type: 'response', id: command.id, command: command.type, success: true, data: {} }), 500)
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    pendingPrompt = command
    if (typeof command.message === 'string' && command.message.includes('stay busy')) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prompt-args.json'))}, JSON.stringify(command))
      streaming = true
      send({ type: 'agent_start' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      return
    }
    if (typeof command.message === 'string' && command.message.includes('mark the browser page')) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'browser-tool-env.json'))}, JSON.stringify({
        url: process.env.PRIME_WORK_BROWSER_URL || '',
        hasToken: Boolean(process.env.PRIME_WORK_BROWSER_TOKEN),
      }))
      const browserUrl = process.env.PRIME_WORK_BROWSER_URL
      const browserToken = process.env.PRIME_WORK_BROWSER_TOKEN
      const postBrowser = (method, params) => new Promise((resolve) => {
        if (!browserUrl || !browserToken) {
          const missing = JSON.stringify({ ok: false, error: 'Browser capability env was not injected' })
          fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'browser-tool-result.json'))}, missing)
          resolve(missing)
          return
        }
        const target = new URL(browserUrl)
        const body = JSON.stringify({ method, params })
        const request = require('node:http').request({
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + browserToken,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (response) => {
          let data = ''
          response.on('data', (chunk) => { data += chunk })
          response.on('end', () => {
            fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'browser-tool-result.json'))}, data)
            resolve(data)
          })
        })
        request.on('error', (error) => {
          const failed = JSON.stringify({ ok: false, error: String(error) })
          fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'browser-tool-result.json'))}, failed)
          resolve(failed)
        })
        request.write(body)
        request.end()
      })
      pendingPrompt = command
      streaming = true
      send({ type: 'agent_start' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      postBrowser('evaluate', { code: 'document.body.setAttribute("data-agent-round-trip", "ok"); return document.body.getAttribute("data-agent-round-trip")' }).then((raw) => {
        streaming = false
        const completedAt = new Date().toISOString()
        fs.appendFileSync(sessionFile, JSON.stringify({
          type: 'message', id: 'fixture-browser-round-trip', parentId: 'fixture-goal-summary', timestamp: completedAt,
          message: { role: 'assistant', timestamp: completedAt, content: 'Browser tool round trip complete.' },
        }) + '\\n')
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Browser tool round trip complete. ' + String(raw).slice(0, 200) } })
        send({ type: 'agent_end' })
        pendingPrompt = undefined
      })
      return
    }
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prompt-args.json'))}, JSON.stringify(command))
    send({ type: 'agent_start' })
    if (typeof command.message !== 'string' || !command.message.includes('two questions')) {
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Fixture response.' } })
      send({ type: 'agent_end' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      pendingPrompt = undefined
      return
    }
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '**Reviewing the available release channels before asking for input.**' } })
    send({ type: 'tool_execution_start', toolCallId: 'ask-2', toolName: 'ask_user', args: { questions: [
      { question: 'Which release channel?', options: ['Stable', 'Beta'] },
      { question: 'What should I optimize for?', options: ['Speed', 'Safety'] },
    ] } })
    send({ type: 'extension_ui_request', id: 'fixture-question-1', method: 'select', title: 'Which release channel?', options: ['__prime_ask_user__fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
    send({ type: 'extension_ui_request', id: 'fixture-question-2', method: 'select', title: 'What should I optimize for?', options: ['__prime_ask_user__fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
  } else if (command.type === 'extension_ui_response' && pendingPrompt) {
    pendingPrompt.values = { ...(pendingPrompt.values || {}), [command.id]: command.value }
    if (Object.keys(pendingPrompt.values).length < 2) return
    const prompt = pendingPrompt
    pendingPrompt = undefined
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'questionnaire-values.json'))}, JSON.stringify(prompt.values))
    send({ type: 'tool_execution_end', toolCallId: 'ask-2', toolName: 'ask_user', result: { values: prompt.values } })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The questionnaire answers are ready.' } })
    const completedAt = new Date().toISOString()
    fs.appendFileSync(sessionFile, [
      JSON.stringify({ type: 'message', id: 'fixture-live-assistant-multi', parentId: 'fixture-goal-summary', message: { role: 'assistant', timestamp: completedAt, content: [{ type: 'toolCall', id: 'ask-2', name: 'ask_user', arguments: { questions: [{ question: 'Which release channel?', options: ['Stable', 'Beta'] }, { question: 'What should I optimize for?', options: ['Speed', 'Safety'] }] } }] } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-result-multi', parentId: 'fixture-live-assistant-multi', message: { role: 'toolResult', timestamp: completedAt, toolCallId: 'ask-2', toolName: 'ask_user', content: JSON.stringify({ values: prompt.values }) } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-final-multi', parentId: 'fixture-live-result-multi', message: { role: 'assistant', timestamp: completedAt, content: 'The questionnaire answers are ready.' } }),
    ].join('\\n') + '\\n')
    send({ type: 'agent_end' })
    send({ type: 'response', id: prompt.id, command: prompt.type, success: true, data: {} })
    setTimeout(() => {
      const refreshedAt = new Date().toISOString()
      fs.appendFileSync(sessionFile, JSON.stringify({
        type: 'session_info',
        id: 'fixture-post-completion-catalog-refresh',
        parentId: 'fixture-live-final-multi',
        timestamp: refreshedAt,
        name: 'Post-completion catalog refresh',
      }) + '\\n')
    }, 250)
  } else if (command.id) {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(executable, 0o755)
  const ompExecutable = join(fixtureRoot, 'omp-fixture.cjs')
  writeFileSync(ompExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('omp/17.2.11\\n'); process.exit(0) }
if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ models: [
    { provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] },
    { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] },
  ] })); process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') process.exit(2)
fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'omp-runtime-args.json'))}, JSON.stringify(args))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const resumeIndex = args.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(ompSessionFile)}
let negotiated = false
let pendingPrompt
let answers = {}
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    negotiated = true
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: 2 } })
  } else if (!negotiated) {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Protocol was not negotiated' })
  } else if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {
      sessionId: '019fdf24-aaaa-7000-8000-000000000001', sessionFile, isStreaming: false, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture' },
      contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 } } })
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    pendingPrompt = command
    answers = {}
    send({ type: 'agent_start' })
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
    send({ type: 'tool_execution_start', toolCallId: 'omp-ask-2', toolName: 'ask_user', args: { questions: [
      { question: 'Which OMP release channel?', options: ['Stable', 'Beta'] },
      { question: 'What should OMP optimize for?', options: ['Speed', 'Safety'] },
    ] } })
    send({ type: 'extension_ui_request', id: 'omp-fixture-question-1', method: 'select', title: 'Which OMP release channel?', options: ['__prime_ask_user__omp-fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
    send({ type: 'extension_ui_request', id: 'omp-fixture-question-2', method: 'select', title: 'What should OMP optimize for?', options: ['__prime_ask_user__omp-fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
  } else if (command.type === 'extension_ui_response') {
    answers[command.id] = command.value
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
    if (pendingPrompt && Object.keys(answers).length === 2) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'omp-questionnaire-values.json'))}, JSON.stringify(answers))
      pendingPrompt = undefined
      send({ type: 'tool_execution_end', toolCallId: 'omp-ask-2', toolName: 'ask_user', result: { values: answers } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The OMP questionnaire answers are ready.' } })
      send({ type: 'agent_end', isTerminal: true })
    }
  } else if (command.id) {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(ompExecutable, 0o755)
  const piExecutable = join(fixtureRoot, 'pi-fixture.cjs')
  writeFileSync(piExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('0.84.1\\n'); process.exit(0) }
if (args[0] === 'install' || args[0] === 'remove') {
  const settingsPath = require('node:path').join(process.env.HOME, '.pi', 'agent', 'settings.json')
  fs.mkdirSync(require('node:path').dirname(settingsPath), { recursive: true })
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch {}
  const packages = Array.isArray(settings.packages) ? settings.packages.filter((source) => source !== args[1]) : []
  if (args[0] === 'install') packages.push(args[1])
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, packages }))
  process.stdout.write(args[0] === 'install' ? 'installed\\n' : 'removed\\n')
  process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') process.exit(2)
if (!args.includes('--no-session')) fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'pi-runtime-args.json'))}, JSON.stringify({ args, cwd: process.cwd() }))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const sessionIndex = args.indexOf('--session')
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : ${JSON.stringify(piSessionFile)}
let pendingPrompt
let answers = {}
// Base pi pushes no ready frame and negotiates nothing: answer Prime-shaped
// request/response envelopes immediately.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_available_models') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { models: [
      { provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture', api: 'anthropic-messages', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
      { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture', api: 'openai-responses', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
    ] } })
  } else if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {
      sessionId: '019fdf24-bbbb-7000-8000-000000000002', sessionFile, isStreaming: false, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture' },
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 } } })
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'pi-prompt-args.json'))}, JSON.stringify(command))
    send({ type: 'agent_start' })
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
    if (typeof command.message === 'string' && command.message.includes('two Pi questions')) {
      pendingPrompt = command
      answers = {}
      send({ type: 'tool_execution_start', toolCallId: 'pi-ask-2', toolName: 'ask_user', args: { questions: [
        { question: 'Which Pi release channel?', options: ['Stable', 'Beta'] },
        { question: 'What should Pi optimize for?', options: ['Speed', 'Safety'] },
      ] } })
      send({ type: 'extension_ui_request', id: 'pi-fixture-question-1', method: 'select', title: 'Which Pi release channel?', options: ['__prime_ask_user__pi-fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
      send({ type: 'extension_ui_request', id: 'pi-fixture-question-2', method: 'select', title: 'What should Pi optimize for?', options: ['__prime_ask_user__pi-fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
      return
    }
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi fixture response.' } })
    send({ type: 'agent_end' })
  } else if (command.type === 'extension_ui_response') {
    answers[command.id] = command.value
    if (pendingPrompt && Object.keys(answers).length === 2) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'pi-questionnaire-values.json'))}, JSON.stringify(answers))
      pendingPrompt = undefined
      send({ type: 'tool_execution_end', toolCallId: 'pi-ask-2', toolName: 'ask_user', result: { values: answers } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The Pi questionnaire answers are ready.' } })
      send({ type: 'agent_end' })
    }
  } else if (command.id) {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(piExecutable, 0o755)
  const cuaExecutable = join(fixtureRoot, 'cua-driver-fixture.cjs')
  writeFileSync(cuaExecutable, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('cua-driver 0.19.0\\n'); process.exit(0) }
process.exit(2)
`)
  chmodSync(cuaExecutable, 0o755)
  return { userData, home, project, executable, ompExecutable, piExecutable, cuaExecutable, sessionFile: realpathSync(sessionFile) }
}

export function hermeticEnvironment(home: string, executable: string, ompExecutable: string, piExecutable: string, cuaExecutable: string, restrictPath = false): NodeJS.ProcessEnv {
  let path = process.env.PATH
  if (restrictPath) {
    const bin = join(fixtureRoot, 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
    path = bin
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: path,
    TMPDIR: fixtureRoot,
    SHELL: '/bin/zsh',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PRIME_WORK_E2E_HIDE_WINDOWS: '1',
    PRIME_AGENT_BINARY: executable,
    OMP_BINARY: ompExecutable,
    PI_BINARY: piExecutable,
    CUA_DRIVER_PATH: cuaExecutable,
  }
  for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) env[key] = process.env[key]
  return env
}

export function markAppClosed(): void {
  app = undefined
}

export async function relaunchHermeticApp(): Promise<void> {
  await closeHermeticApp(app)
  app = undefined
  if (!currentFixture) throw new Error('Missing hermetic fixture for relaunch')
  app = await electron.launch({
    args: ['.', `--user-data-dir=${currentFixture.userData}`],
    cwd: process.cwd(),
    env: hermeticEnvironment(currentFixture.home, currentFixture.executable, currentFixture.ompExecutable, currentFixture.piExecutable, currentFixture.cuaExecutable, false) as Record<string, string>,
    timeout: 20_000,
  })
  app.context().on('page', attachDiagnostics)
  for (const target of app.windows()) attachDiagnostics(target)
  page = await app.firstWindow({ timeout: 15_000 })
  attachDiagnostics(page)
}

export function attachHermeticHooks(): void {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright derives fixture usage from this destructuring pattern
  test.beforeEach(async ({}, testInfo) => {
    actionableErrors = []
    app = undefined
    const activeSession = testInfo.title === 'defers a reply to a session that is active outside Prime Work'
      || testInfo.title === 'reflects an external JSONL append without reselecting the live session'
    const liveInstall = testInfo.title === 'adds and connects to a harness installed while the app is open'
    const noHarnesses = testInfo.title === 'opens Harness settings from the no-harness recovery prompt'
    const authenticatedMcp = testInfo.title === 'shows built-in Prime MCPs without inspecting or changing authorization'
    let startupError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fixture = createHermeticFixture(activeSession)
      if (authenticatedMcp) writeFileSync(join(fixture.home, '.prime', 'agent', 'auth.json'), JSON.stringify({ 'mcp:notion': { type: 'oauth', access: 'fixture-token', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 } }))
      currentFixture = fixture
      fixtureSessionFile = fixture.sessionFile
      if (liveInstall) renameSync(fixture.ompExecutable, `${fixture.ompExecutable}.pending`)
      if (noHarnesses) {
        for (const executable of [fixture.executable, fixture.ompExecutable, fixture.piExecutable]) renameSync(executable, `${executable}.pending`)
      }
      try {
        app = await electron.launch({
          args: ['.', `--user-data-dir=${fixture.userData}`],
          cwd: process.cwd(),
          env: hermeticEnvironment(fixture.home, fixture.executable, fixture.ompExecutable, fixture.piExecutable, fixture.cuaExecutable, liveInstall || noHarnesses) as Record<string, string>,
          timeout: 20_000,
        })
        app.context().on('page', attachDiagnostics)
        for (const target of app.windows()) attachDiagnostics(target)
        page = await app.firstWindow({ timeout: 15_000 })
        attachDiagnostics(page)
        await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
        return
      } catch (error) {
        startupError = error
        await closeHermeticApp(app)
        app = undefined
        if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
        fixtureRoot = ''
        fixtureSessionFile = ''
      }
    }
    throw startupError ?? new Error('Prime Work did not create its initial window')
  })

  test.afterEach(async () => {
    await closeHermeticApp(app)
    app = undefined
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
    fixtureSessionFile = ''
    currentFixture = undefined
  })
}
