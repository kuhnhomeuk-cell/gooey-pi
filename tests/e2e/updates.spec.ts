import { app, attachHermeticHooks, expect, page, test } from './fixtures/desktop'

test.describe('Prime Work updates', () => {
  test.describe.configure({ mode: 'parallel' })
  attachHermeticHooks()

  test('loads the sandboxed preload bridge and hermetic service data', async () => {
    const bridge = await page.evaluate(() => {
      const prime = (window as typeof window & { prime?: Record<string, unknown> }).prime
      const voice = prime?.voice
      return { type: typeof prime, groups: prime ? Object.keys(prime).sort() : [], voiceMethods: voice && typeof voice === 'object' ? Object.keys(voice).sort() : [] }
    })
    expect(bridge.type).toBe('object')
    expect(bridge.groups).toEqual(['agent', 'app', 'browser', 'factory', 'git', 'heartbeats', 'pets', 'plugins', 'projects', 'providers', 'schedules', 'sessions', 'settings', 'terminal', 'updates', 'voice'])
    expect(bridge.voiceMethods).toContain('testSelfHosted')
    const updateMenu = await app!.evaluate(({ Menu }) => {
      const parents = Menu.getApplicationMenu()?.items ?? []
      const parent = parents.find((item) => item.submenu?.items.some((child) => child.label === 'Check for Updates…'))
      return { found: Boolean(parent), parent: parent?.label, platform: process.platform }
    })
    expect(updateMenu.found).toBe(true)
    expect(updateMenu.parent).toBe(updateMenu.platform === 'darwin' ? 'GooeyPi' : 'Help')
    await expect(page.evaluate(() => window.prime.updates.getState())).resolves.toMatchObject({ phase: 'unsupported' })
    const credentialStatus = await page.evaluate(() => window.prime.voice.credentialStatus())
    expect(typeof credentialStatus.storage.available).toBe('boolean')
    if (!credentialStatus.storage.available) expect(credentialStatus.storage.message).toMatch(/secure|credential|keyring|kwallet/i)
    const invalidSelfHostedTest = await page.evaluate(async () => {
      try { await window.prime.voice.testSelfHosted({ url: '', model: '' }); return '' }
      catch (error) { return String(error) }
    })
    expect(invalidSelfHostedTest).toMatch(/too short|Invalid URL/)
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true)
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.sidebar__brand small')).toHaveText('Work')
    await expect(page.locator('.sidebar__brand .prime-mark svg path')).toHaveCount(2)
    await expect(page.locator('.prime-mark img')).toHaveCount(0)
    await expect(page.locator('.sidebar__footer .sidebar-update')).toHaveCount(0)
    await expect(page.locator('.sidebar__footer button[title="Settings"]')).toBeVisible()
  })

})
