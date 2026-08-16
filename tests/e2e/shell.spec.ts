import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_DESKTOP_STATE_FILENAME } from '../../electron/main/store'
import { app, attachHermeticHooks, closePrompts, expect, fixtureRoot, markAppClosed, page, stubCloseDialog, test } from './fixtures/desktop'

test.describe('Prime Work shell', () => {
  test.describe.configure({ mode: 'parallel' })
  attachHermeticHooks()

  test('left aligns the harness picker for Linux and Windows chrome', async () => {
    const shell = page.locator('.app-shell')
    const sidebar = page.locator('.sidebar')
    const clearance = page.locator('.sidebar__titlebar .traffic-light-clearance')
    const trigger = page.getByRole('button', { name: 'Prime Work — switch harness' })
    for (const platform of ['linux', 'win32']) {
      await shell.evaluate((node, value) => { node.setAttribute('data-platform', value) }, platform)
      await expect(clearance).toHaveCSS('display', 'none')
      const offset = await trigger.evaluate((node) => node.getBoundingClientRect().left - node.closest('.sidebar')!.getBoundingClientRect().left)
      expect(offset).toBeLessThanOrEqual(8)
      expect(offset).toBeGreaterThanOrEqual(0)
    }
    await expect(sidebar).toBeVisible()
  })

  test('uses overlay panels at the compact desktop breakpoint', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 960, height: 700 })
    await expect.poll(() => page.locator('.sidebar').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.inspector')).toHaveCount(0)
    const sidebarScrim = page.getByRole('button', { name: 'Close sidebar' })
    await expect(page.locator('.panel-scrim--sidebar')).toBeVisible()
    await expect(sidebarScrim).toBeVisible()
    await sidebarScrim.click({ position: { x: 400, y: 300 } })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)
    // Panel reconciliation may restore a confirmed inspector preference after
    // the sidebar closes. Normalize either valid state before testing the toggle.
    await page.waitForTimeout(250)
    if (await page.locator('.inspector').count()) {
      await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
    await expect(page.locator('.title-toolbar')).not.toHaveAttribute('inert')
    const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' })
    await inspectorToggle.focus()
    await inspectorToggle.press('Enter')
    await expect.poll(() => page.locator('.inspector').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.locator('.panel-scrim--inspector')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 920 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(980)
    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
  })

  test('auto-closes both drawers at the smallest breakpoint while keeping them user-toggleable', async () => {
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Show sidebar/ })).toBeVisible()
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)

    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.locator('.sidebar').getByRole('button', { name: /Hide sidebar/ }).click()
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)

    await page.setViewportSize({ width: 721, height: 700 })
    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)

    const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' })
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toBeVisible()
    await expect(page.locator('.title-toolbar')).not.toHaveAttribute('inert')
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).inspectorOpen)).toBe(false)

    await page.setViewportSize({ width: 721, height: 700 })
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).inspectorOpen)).toBe(false)
  })

  test('resizes the inspector horizontally and terminal vertically', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Summary' }).click()

    const inspector = page.locator('.inspector')
    const inspectorHandle = page.getByRole('separator', { name: 'Resize inspector' })
    await expect(inspectorHandle).toBeVisible()
    const inspectorBefore = await inspector.boundingBox()
    const inspectorHandleBox = await inspectorHandle.boundingBox()
    expect(inspectorBefore).not.toBeNull()
    expect(inspectorHandleBox).not.toBeNull()
    await page.mouse.move(inspectorHandleBox!.x + inspectorHandleBox!.width / 2, inspectorHandleBox!.y + 80)
    await page.mouse.down()
    await page.mouse.move(inspectorHandleBox!.x - 72, inspectorHandleBox!.y + 80, { steps: 5 })
    await page.mouse.up()
    const inspectorAfter = await inspector.boundingBox()
    expect(inspectorAfter!.width).toBeGreaterThan(inspectorBefore!.width + 50)
    await inspectorHandle.focus()
    await page.keyboard.press('ArrowRight')
    expect((await inspector.boundingBox())!.width).toBeLessThan(inspectorAfter!.width)

    await page.getByLabel(/Toggle terminal/).click()
    const drawer = page.locator('.terminal-drawer')
    const terminalHandle = page.getByRole('separator', { name: 'Resize terminal' })
    await expect(terminalHandle).toBeVisible()
    const terminalBefore = await drawer.boundingBox()
    expect(terminalBefore).not.toBeNull()
    await expect.poll(async () => Number(await terminalHandle.getAttribute('aria-valuemax'))).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.hover()
    const terminalHandleBox = await terminalHandle.boundingBox()
    expect(terminalHandleBox).not.toBeNull()
    const terminalHandleCenter = {
      x: terminalHandleBox!.x + terminalHandleBox!.width / 2,
      y: terminalHandleBox!.y + terminalHandleBox!.height / 2,
    }
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y)
    await page.mouse.down()
    await expect(terminalHandle).toHaveAttribute('data-resizing', 'true')
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y - 64, { steps: 5 })
    await page.mouse.up()
    const terminalAfter = await drawer.boundingBox()
    expect(terminalAfter!.height).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.focus()
    await page.keyboard.press('ArrowDown')
    expect((await drawer.boundingBox())!.height).toBeLessThan(terminalAfter!.height)
    await page.getByLabel('Close terminal', { exact: true }).click()
  })

  test('closes immediately when no agent or schedule is active', async () => {
    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    const dialogCalls = await app!.evaluate(({ BrowserWindow, dialog }) => {
      let calls = 0
      const closeDialog = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<unknown> }
      closeDialog.showMessageBox = () => {
        calls += 1
        return Promise.resolve({ response: 0 })
      }
      BrowserWindow.getAllWindows()[0]?.close()
      return calls
    })
    expect(dialogCalls).toBe(0)
    await closed
    markAppClosed()
  })

  test('asks before closing and quits after confirmation while an agent runs', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('stay busy while I close the window')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop Prime' })).toBeVisible()
    await stubCloseDialog(app!)

    const runningPrompt = {
      message: 'Close GooeyPi while an agent is running?',
      detail: 'An agent run is still in progress and will be stopped.',
      buttons: ['Cancel', 'Close GooeyPi'],
    }
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt])
    await expect(page.locator('.app-shell')).toBeVisible()

    // Quit routes through the same confirmation instead of bypassing it.
    await app!.evaluate(({ app: electronApp }) => { electronApp.quit() })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt, runningPrompt])
    await expect(page.locator('.app-shell')).toBeVisible()

    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    await app!.evaluate(({ app: electronApp }) => {
      (globalThis as { __closeResponse?: number }).__closeResponse = 1
      electronApp.quit()
    })
    await closed
    markAppClosed()
  })

  test('traps modal focus, closes on Escape, and restores the trigger', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Browser', exact: true }).first().click()
    const trigger = page.getByRole('button', { name: 'Clear data' })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Clear browser data?' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(page.locator('.app-shell')).toHaveAttribute('inert')
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert')
  })

  test('enforces the live preload and IPC frame boundaries', async () => {
    const initialMeta = await page.evaluate(() => window.prime.app.getMeta())
    expect(initialMeta.version).toBeTruthy()

    await page.evaluate(() => { window.location.hash = 'cfr-11-safe-fragment' })
    await expect(page).toHaveURL(/#cfr-11-safe-fragment$/)
    const fragmentMeta = await page.evaluate(() => window.prime.app.getMeta())
    expect(fragmentMeta).toEqual(initialMeta)

    await page.evaluate(() => {
      const iframe = document.createElement('iframe')
      iframe.name = 'untrusted-subframe'
      iframe.srcdoc = '<!doctype html><title>Untrusted subframe</title>'
      document.body.append(iframe)
    })
    await expect.poll(() => Boolean(page.frame({ name: 'untrusted-subframe' }))).toBe(true)
    const subframe = page.frame({ name: 'untrusted-subframe' })
    expect(subframe).not.toBeNull()
    await subframe!.waitForLoadState()
    expect(await subframe!.evaluate(() => typeof (window as Window & { prime?: unknown }).prime)).toBe('undefined')

    const deniedUrl = 'data:text/html,<title>Untrusted renderer</title><main>untrusted</main>'
    await app!.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Expected the Prime Work window')
      await window.loadURL(url)
    }, deniedUrl)
    await expect(page).toHaveURL(/^data:text\/html,/)
    const deniedAccess = await page.evaluate(async () => {
      const prime = (window as Window & { prime?: typeof window.prime }).prime
      if (!prime) return { bridge: 'undefined', result: 'unavailable' }
      try {
        await prime.app.getMeta()
        return { bridge: 'object', result: 'resolved' }
      } catch (error) {
        return { bridge: 'object', result: error instanceof Error ? error.message : String(error) }
      }
    })
    expect(deniedAccess.bridge).toBe('object')
    expect(deniedAccess.result).toMatch(/IPC sender is not authorized/i)
  })

  test('navigates all primary workspace pages and command palette', async () => {
    for (const destination of ['Projects', 'Activity', 'Scheduled', 'Capabilities']) {
      await page.getByRole('button', { name: destination, exact: true }).click()
      await expect(page.locator('.page')).toBeVisible()
      if (destination === 'Capabilities') {
        await expect(page.locator('.feature-strip')).toHaveCount(0)
        await expect(page.locator('.directory-tools')).toBeVisible()
        const askUserToggle = page.getByRole('button', { name: 'Enable Ask user' })
        await expect(askUserToggle).toHaveAttribute('aria-pressed', 'false')
        await askUserToggle.click()
        await expect(page.getByRole('button', { name: 'Disable Ask user' })).toHaveAttribute('aria-pressed', 'true')
        await page.getByRole('button', { name: 'Disable Ask user' }).click()
        const askUserConfirmation = page.getByRole('dialog', { name: 'Disable Ask user?' })
        await expect(askUserConfirmation).toContainText('Are you sure?')
        await askUserConfirmation.getByRole('button', { name: 'Yes, disable' }).click()
        await expect(page.getByRole('button', { name: 'Enable Ask user' })).toHaveAttribute('aria-pressed', 'false')
        await page.getByRole('button', { name: 'Enable Ask user' }).click()
        await expect(page.getByRole('button', { name: 'Disable Ask user' })).toHaveAttribute('aria-pressed', 'true')
        const browserToggle = page.getByRole('button', { name: 'Disable Browser' })
        await browserToggle.click()
        const browserConfirmation = page.getByRole('dialog', { name: 'Disable Browser?' })
        await browserConfirmation.getByRole('button', { name: 'Cancel' }).click()
        await expect(page.getByRole('button', { name: 'Disable Browser' })).toHaveAttribute('aria-pressed', 'true')
        const computerUseToggle = page.getByRole('button', { name: 'Enable Computer Use | TryCUA' })
        await expect(computerUseToggle).toHaveAttribute('aria-pressed', 'false')
        await computerUseToggle.click()
        await expect(page.getByRole('button', { name: 'Disable Computer Use | TryCUA' })).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.computerUseEnabled).toBe(true)
        await expect(page.getByText(/Prime MCP integrations require a matching Python skill package/)).toHaveCount(0)
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        const addDialog = page.getByRole('dialog', { name: 'Add a Prime capability' })
        await expect(addDialog.getByText('Add MCP', { exact: true })).toBeVisible()
        await expect(addDialog.getByText('Add Package', { exact: true })).toBeVisible()
        await expect(addDialog.getByText('Add Extension', { exact: true })).toBeVisible()
        await expect(addDialog.getByText(/Not every third-party package, plugin, or extension will work in GooeyPi/)).toBeVisible()
        await addDialog.getByRole('button', { name: /Add MCP/ }).click()
        const mcpDialog = page.getByRole('dialog', { name: 'Add MCP server' })
        await expect(mcpDialog.getByText(/Not every third-party/)).toHaveCount(0)
        await expect(mcpDialog.getByText(/Prime MCP integrations require a matching Python skill package/)).toBeVisible()
        await expect(mcpDialog.getByText('Integration package source', { exact: true })).toBeVisible()
        await expect(mcpDialog.getByText('Local command', { exact: true })).toHaveCount(0)
        await mcpDialog.getByRole('button', { name: 'Close' }).click()
      }
    }
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await expect(page.getByLabel('Search providers')).toBeVisible()
    await expect(page.locator('.provider-row')).not.toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Disable all', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Disable all', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Enable all', exact: true })).toBeVisible()
    await expect(page.locator('.provider-row input[type="checkbox"]:checked')).toHaveCount(0)
    await page.getByRole('tab', { name: /Models/ }).click()
    await expect(page.getByLabel('Search models')).toBeVisible()
    await expect(page.locator('.provider-model-row')).not.toHaveCount(0)
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /Show reasoning summaries/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /Show tool calls/ })).toBeChecked()
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('keeps transcript text from showing through the composer disclaimer', async () => {
    await page.getByRole('button', { name: 'Toggle inspector' }).click()
    await expect(page.locator('.composer-note')).toBeVisible()
    const colors = await page.locator('.composer-note').evaluate((node) => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--canvas)'
      document.body.append(probe)
      const canvas = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { note: getComputedStyle(node).backgroundColor, canvas }
    })
    expect(colors.note).toBe(colors.canvas)
    expect(colors.note).not.toContain('rgba')
  })

})
