// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STREAMING_PARSE_INTERVAL_MS } from '../../src/components/MarkdownText'
import type { TranscriptMessage } from '../../src/types/api'

const parseCommits = vi.hoisted(() => ({ count: 0 }))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => {
    parseCommits.count += 1
    return createElement('div', { 'data-md': String(children ?? '') })
  },
}))

const { Transcript } = await import('../../src/components/Transcript')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const git = { isRepo: false, files: [] }
const noop = () => undefined

function streamingMessage(text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: 'live',
    role: 'assistant',
    timestamp: 1_000,
    startedAt: 1_000,
    streaming: true,
    parts: [{ type: 'text', text }],
    ...extra,
  }
}

describe('live Transcript Markdown parse budget', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    parseCommits.count = 0
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  function renderLive(message: TranscriptMessage) {
    act(() => {
      root.render(createElement(Transcript, {
        messages: [message],
        git,
        active: true,
        onOpenChanges: noop,
        onSuggestion: noop,
      }))
    })
  }

  it('throttles ReactMarkdown commits on the live answer to the streaming interval', () => {
    let text = 'Hello'
    renderLive(streamingMessage(text))
    const afterMount = parseCommits.count

    for (let index = 0; index < 20; index += 1) {
      text += 'x'
      renderLive(streamingMessage(text))
    }
    const afterBursts = parseCommits.count

    act(() => { vi.advanceTimersByTime(STREAMING_PARSE_INTERVAL_MS) })
    const afterInterval = parseCommits.count

    expect(afterBursts - afterMount).toBeLessThanOrEqual(2)
    expect(afterBursts).toBeLessThan(20)
    expect(afterInterval - afterMount).toBeLessThanOrEqual(3)
    expect(afterInterval).toBeLessThan(20)
  })

  it('throttles live timeline note text the same way', () => {
    let text = 'Note'
    const withActivity = (note: string): TranscriptMessage => ({
      id: 'live',
      role: 'assistant',
      timestamp: 1_000,
      startedAt: 1_000,
      streaming: true,
      parts: [
        { type: 'thinking', text: 'planning' },
        { type: 'text', text: note },
      ],
    })
    renderLive(withActivity(text))
    const afterMount = parseCommits.count

    for (let index = 0; index < 20; index += 1) {
      text += 'x'
      renderLive(withActivity(text))
    }
    const afterBursts = parseCommits.count
    act(() => { vi.advanceTimersByTime(STREAMING_PARSE_INTERVAL_MS) })
    const afterInterval = parseCommits.count

    expect(afterBursts - afterMount).toBeLessThanOrEqual(3)
    expect(afterBursts).toBeLessThan(20)
    expect(afterInterval - afterMount).toBeLessThanOrEqual(4)
    expect(afterInterval).toBeLessThan(20)
  })
})
