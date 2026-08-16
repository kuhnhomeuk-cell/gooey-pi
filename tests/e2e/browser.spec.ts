import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actionableErrors, app, attachHermeticHooks, expect, fixtureRoot, page, test } from './fixtures/desktop'

test.describe('Prime Work browser', () => {
  test.describe.configure({ mode: 'parallel' })
  attachHermeticHooks()

  test('attaches an isolated browser guest without navigation errors', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const guest = page.locator('webview[partition="persist:prime-work-browser"]')
    await expect(guest).toHaveCount(1)
    await expect.poll(() => guest.evaluate(async (node) => {
      const webview = node as HTMLElement & { executeJavaScript(script: string): Promise<unknown> }
      return webview.executeJavaScript('typeof window.prime')
    })).toBe('undefined')
    await page.waitForTimeout(2_500)
    expect(actionableErrors.filter((error) => /ERR_ABORTED|GUEST_VIEW_MANAGER_CALL/i.test(error))).toEqual([])
    await page.getByRole('tab', { name: 'Browser' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  })

  test('destroys an open session browser guest when its thread is archived', async () => {
    const sessionRow = page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' })
    await sessionRow.locator('.session-row').click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const preview = page.locator('.browser-preview webview[partition="persist:prime-work-browser"]')
    await expect(preview).toHaveCount(1)
    await expect.poll(() => preview.evaluate(async (node) => {
      const webview = node as HTMLElement & {
        executeJavaScript(script: string): Promise<unknown>
        getWebContentsId(): number
      }
      await webview.executeJavaScript('window.__fixtureGameTimer = setInterval(() => {}, 10)')
      return webview.getWebContentsId()
    })).toBeGreaterThan(0)
    const guestId = await preview.evaluate((node) => (node as HTMLElement & { getWebContentsId(): number }).getWebContentsId())
    expect(await app!.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), guestId)).toBe(true)

    await sessionRow.getByTitle('Archive Hermetic desktop fixture').click()
    await sessionRow.getByTitle('Confirm archive Hermetic desktop fixture').click()

    await expect(sessionRow).toHaveCount(0)
    await expect.poll(() => app!.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)
      return guest === undefined || guest.isDestroyed()
    }, guestId)).toBe(true)
    await expect.poll(() => preview.evaluate((node) => (node as HTMLElement & { getWebContentsId(): number }).getWebContentsId())).not.toBe(guestId)
  })

  test('completes an agent-tool-to-webview evaluate round trip', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const preview = page.locator('.browser-preview webview[partition="persist:prime-work-browser"]')
    await expect(preview).toHaveCount(1)
    await expect.poll(() => preview.evaluate(async (node) => {
      const webview = node as HTMLElement & { executeJavaScript(script: string): Promise<unknown> }
      return webview.executeJavaScript('document.readyState')
    })).toBeTruthy()

    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Please mark the browser page through the agent browser tool')
    await composer.press('Enter')

    const resultPath = join(fixtureRoot, 'browser-tool-result.json')
    await expect.poll(() => existsSync(resultPath)).toBe(true)
    const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as { ok?: boolean; result?: { ok?: boolean; value?: string }; error?: string }
    expect(payload.ok, payload.error).toBe(true)
    expect(payload.result?.ok).toBe(true)
    expect(payload.result?.value).toMatch(/ok/)
    await expect.poll(() => preview.evaluate(async (node) => {
      const webview = node as HTMLElement & { executeJavaScript(script: string): Promise<unknown> }
      return webview.executeJavaScript('document.body.getAttribute("data-agent-round-trip")')
    })).toBe('ok')
    await expect(page.getByText('Browser tool round trip complete.')).toBeVisible()
  })

})
