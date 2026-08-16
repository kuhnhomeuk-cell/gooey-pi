// @vitest-environment jsdom

import { act, createElement, memo, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as syntaxText from '../../src/lib/syntax-text'
import type { MessagePart, TranscriptMessage } from '../../src/types/api'

const rowRenders = vi.hoisted(() => {
  const counts = new Map<string, number>()
  return {
    counts,
    record(id: string) { counts.set(id, (counts.get(id) ?? 0) + 1) },
    reset() { counts.clear() },
    snapshot() { return new Map(counts) },
  }
})

vi.mock('../../src/components/transcript/messages', async (importOriginal) => {
  const React = await import('react')
  const actual = await importOriginal<typeof import('../../src/components/transcript/messages')>()
  const track = <Props extends { message: { id: string } }>(name: string, Component: React.ComponentType<Props>) =>
    memo(function Tracked(props: Props) {
      return React.createElement(Profiler, {
        id: `${name}:${props.message.id}`,
        onRender: () => { rowRenders.record(`${name}:${props.message.id}`) },
      }, React.createElement(Component, props))
    })
  return {
    ...actual,
    UserMessage: track('user', actual.UserMessage),
    AssistantMessage: track('assistant', actual.AssistantMessage),
  }
})

const { Transcript } = await import('../../src/components/Transcript')
const { WorkTimeline } = await import('../../src/components/transcript/timeline')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const git = { isRepo: false, files: [] }
const noop = () => undefined

function userMessage(id: string): TranscriptMessage {
  return { id, role: 'user', timestamp: 1, parts: [{ type: 'text', text: `ask ${id}` }] }
}

function finishedAssistant(id: string): TranscriptMessage {
  return {
    id, role: 'assistant', timestamp: 2, completedAt: 3,
    parts: [{ type: 'text', text: `done ${id}` }],
  }
}

function liveAssistant(text: string, extraParts: MessagePart[] = []): TranscriptMessage {
  return {
    id: 'live',
    role: 'assistant',
    timestamp: 4,
    startedAt: 4,
    streaming: true,
    parts: [...extraParts, { type: 'text', text }],
  }
}

describe('transcript row stability', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    rowRenders.reset()
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 0 } })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => undefined })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function renderTranscript(messages: TranscriptMessage[]) {
    act(() => {
      root.render(createElement(Transcript, {
        messages,
        git,
        active: true,
        onOpenChanges: noop,
        onSuggestion: noop,
        onOpenSessionReference: noop,
      }))
    })
  }

  it('does not re-render historical rows across 20 streaming updates', () => {
    const historical: TranscriptMessage[] = [
      userMessage('user-1'),
      finishedAssistant('asst-1'),
      userMessage('user-2'),
    ]
    let text = 'Hello'
    renderTranscript([...historical, liveAssistant(text)])
    const afterMount = rowRenders.snapshot()
    expect(afterMount.get('user:user-1')).toBe(1)
    expect(afterMount.get('assistant:asst-1')).toBe(1)
    expect(afterMount.get('user:user-2')).toBe(1)
    expect(afterMount.has('assistant:live')).toBe(false)

    for (let index = 0; index < 20; index += 1) {
      text += 'x'
      renderTranscript([...historical, liveAssistant(text)])
    }

    const afterStream = rowRenders.snapshot()
    expect(afterStream.get('user:user-1')).toBe(afterMount.get('user:user-1'))
    expect(afterStream.get('assistant:asst-1')).toBe(afterMount.get('assistant:asst-1'))
    expect(afterStream.get('user:user-2')).toBe(afterMount.get('user:user-2'))
    expect(container.textContent).toContain('Hello')
    expect(container.querySelector('.streaming-state')).not.toBeNull()
  })

  it('keeps 250+ rows stable while the live row updates', () => {
    const historical = Array.from({ length: 250 }, (_, index) => (
      index % 2 === 0 ? userMessage(`u-${index}`) : finishedAssistant(`a-${index}`)
    ))
    let text = 'stream'
    renderTranscript([...historical, liveAssistant(text)])
    const afterMount = rowRenders.snapshot()
    // The newest window is 250 including the live ActiveAssistantMessage row.
    expect(afterMount.size).toBe(249)

    for (let index = 0; index < 20; index += 1) {
      text += '!'
      renderTranscript([...historical, liveAssistant(text)])
    }

    const afterStream = rowRenders.snapshot()
    expect(afterStream).toEqual(afterMount)
    expect(container.textContent).toContain('stream')
    expect(container.querySelector('.streaming-state')).not.toBeNull()
  })

  it('does not re-tokenize tool syntax for unrelated live text deltas', () => {
    const tokenize = vi.spyOn(syntaxText, 'tokenizeSyntaxText')
    const toolCall: MessagePart = { type: 'toolCall', id: 'tool-1', name: 'Read', args: { path: 'src/App.tsx' } }
    const toolResult: MessagePart = { type: 'toolResult', name: 'Read', text: '{"ok": true, "n": 3}' }
    let note = 'working'
    const render = (text: string) => {
      act(() => {
        root.render(createElement(WorkTimeline, {
          parts: [toolCall, toolResult, { type: 'text', text }],
          showReasoning: true,
          showTools: true,
          streaming: true,
        }))
      })
    }

    render(note)
    const afterMount = tokenize.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    for (let index = 0; index < 20; index += 1) {
      note += 'x'
      render(note)
    }

    expect(tokenize.mock.calls.length).toBe(afterMount)
  })
})
