// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_PROJECTS, SAMPLE_SCHEDULES, SAMPLE_SESSIONS } from '../../src/lib/data'
import { ScheduledPage } from '../../src/pages/ScheduledPage'
import type { AutomationScheduleRecord, ScheduleInput, SchedulePatch, ScheduleTiming } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  container.className = 'app-shell'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const node of document.querySelectorAll('.modal-backdrop')) node.remove()
  vi.restoreAllMocks()
})

const schedule = SAMPLE_SCHEDULES[0]

function pageProps(schedules: AutomationScheduleRecord[], handlers: {
  onCreate?: (input: ScheduleInput) => Promise<void>
  onUpdate?: (id: string, patch: SchedulePatch) => Promise<void>
}) {
  return {
    harness: 'prime' as const,
    schedules,
    nativeHeartbeats: [],
    projects: SAMPLE_PROJECTS,
    sessions: SAMPLE_SESSIONS,
    models: [],
    onCreate: handlers.onCreate ?? (async () => undefined),
    onUpdate: handlers.onUpdate ?? (async () => undefined),
    onPause: async () => undefined,
    onResume: async () => undefined,
    onDelete: async () => undefined,
    onRunNow: async () => undefined,
    onPreview: async (timing: ScheduleTiming) => ({ timing, occurrences: [] }),
    onOpenSession: () => undefined,
    onManageHeartbeat: async () => undefined,
  }
}

async function openEditor(schedules: AutomationScheduleRecord[], handlers: Parameters<typeof pageProps>[1] = {}) {
  await act(async () => {
    root.render(<ScheduledPage {...pageProps(schedules, handlers)} />)
  })
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="Open ${schedule.title}"]`)!.click()
  })
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Edit'))!.click()
  })
}

describe('ScheduledPage harness switch', () => {
  it('fails closed when the edited schedule disappears from the list', async () => {
    const onCreate = vi.fn(async () => undefined)
    const onUpdate = vi.fn(async () => undefined)
    await openEditor([schedule], { onCreate, onUpdate })

    await act(async () => {
      root.render(<ScheduledPage {...pageProps([], { onCreate, onUpdate })} />)
    })

    const form = document.querySelector<HTMLFormElement>('#schedule-editor-form')!
    expect(form).toBeTruthy()
    await act(async () => {
      form.requestSubmit()
      await Promise.resolve()
    })

    expect(onCreate).not.toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('no longer available')
  })

  it('still creates a new schedule', async () => {
    const onCreate = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<ScheduledPage {...pageProps([], { onCreate })} />)
    })
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Create schedule'))!.click()
    })

    const form = document.querySelector<HTMLFormElement>('#schedule-editor-form')!
    const title = form.querySelector<HTMLInputElement>('input')!
    const prompt = form.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Nightly check')
      title.dispatchEvent(new Event('input', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Run the checks')
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      form.requestSubmit()
      await Promise.resolve()
    })

    expect(onCreate).toHaveBeenCalledOnce()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nightly check', prompt: 'Run the checks' }))
  })
})
