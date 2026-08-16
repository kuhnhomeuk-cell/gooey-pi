import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_DESKTOP_STATE_FILENAME } from '../../electron/main/store'
import { app, attachHermeticHooks, expect, fixtureRoot, page, relaunchHermeticApp, test } from './fixtures/desktop'

test.describe('Prime Work settings', () => {
  test.describe.configure({ mode: 'parallel' })
  attachHermeticHooks()

  test('persists a desktop-only OMP provider toggle and removes its models from the picker', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    const voiceModelsBefore = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModelsBefore.models.map((model) => model.name).sort()).toEqual(['Claude Fixture', 'GPT Fixture'])
    const anthropic = page.getByRole('checkbox', { name: 'Show anthropic provider' })
    await expect(anthropic).toBeChecked()
    await page.getByTitle('Hide provider in OMP').filter({ has: anthropic }).click()
    await expect(anthropic).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual(['anthropic'])
    const voiceModelsAfter = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModelsAfter.models.map((model) => model.name)).toEqual(['GPT Fixture'])

    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const modelPicker = page.getByRole('combobox', { name: 'Model' })
    await expect(modelPicker.locator('option', { hasText: 'GPT Fixture' })).toHaveCount(1)
    await expect(modelPicker.locator('option', { hasText: 'Claude Fixture' })).toHaveCount(0)
  })

  test('persists an OMP model toggle and removes only that model from every picker', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await page.getByRole('tab', { name: /Models/ }).click()

    const toggle = page.getByRole('checkbox', { name: 'Show GPT Fixture model' })
    const groupHeader = page.locator('.provider-model-group__heading[aria-controls="provider-models-openai-codex"]')
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'true')
    await groupHeader.click()
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeHidden()
    await groupHeader.click()
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeChecked()
    const row = page.locator('.provider-model-row').filter({ has: toggle })
    await expect(row.locator('.provider-model-row__capabilities')).toBeVisible()
    await expect(row.locator('.provider-model-row__toggle')).toBeVisible()
    await row.locator('.provider-model-row__toggle').click()
    await expect(toggle).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledModels).toEqual(['openai-codex/gpt-fixture'])
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual(['openai-codex'])
    const groups = page.locator('.provider-model-group')
    await expect(groups.nth(0)).toContainText('Claude Fixture')
    await expect(groups.nth(1)).toContainText('GPT Fixture')

    const voiceModels = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModels.models.map((model) => model.name)).toEqual(['Claude Fixture'])
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const modelPicker = page.getByRole('combobox', { name: 'Model' })
    await expect(modelPicker.locator('option', { hasText: 'GPT Fixture' })).toHaveCount(0)
    await expect(modelPicker.locator('option', { hasText: 'Claude Fixture' })).toHaveCount(1)

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await page.getByRole('tab', { name: /Models/ }).click()
    const hiddenToggle = page.getByRole('checkbox', { name: 'Show GPT Fixture model' })
    await page.locator('.provider-model-row').filter({ has: hiddenToggle }).locator('.provider-model-row__toggle').click()
    await expect(hiddenToggle).toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledModels).toEqual([])
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual([])
    await page.getByRole('tab', { name: /Providers/ }).click()
    await expect(page.getByRole('checkbox', { name: 'Show openai-codex provider' })).toBeChecked()
  })

  test('keeps Harness settings shared when changing the default while providers follow the active harness', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await expect(page.getByText('OMP approval mode', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Prime Agent executable override')).toBeVisible()
    await expect(page.getByLabel('OMP executable override')).toBeVisible()
    await expect(page.getByLabel('Pi executable override')).toBeVisible()

    const selects = page.locator('.settings-content select')
    await selects.nth(0).selectOption('pi')
    await expect(page.getByRole('button', { name: 'Pi Work — switch harness' })).toBeVisible()
    await expect(page.getByText('OMP approval mode', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await expect(page.getByText('Pi catalogue', { exact: true })).toBeVisible()
  })

  test('refreshes harness discovery through the live settings and preload path', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Harness', exact: true }).click()

    const refresh = page.getByRole('button', { name: 'Refresh harnesses' })
    await expect(refresh).toBeVisible()
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(page.getByText('Prime Agent is ready', { exact: true })).toBeVisible()
    await expect(page.getByText('OMP is ready', { exact: true })).toBeVisible()
    await expect(page.getByText('Pi is ready', { exact: true })).toBeVisible()

    const result = await page.evaluate(() => window.prime.app.refreshHarnesses())
    expect(result.meta.harnesses.prime.path).toBeTruthy()
    expect(result.meta.harnesses.omp.path).toBeTruthy()
    expect(result.meta.harnesses.pi.path).toBeTruthy()

    await page.getByRole('button', { name: /Work — switch harness/ }).click()
    await expect(page.getByRole('menuitemradio')).toHaveCount(3)
  })

  test('adds and connects to a harness installed while the app is open', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await expect(page.getByRole('menuitemradio', { name: /OMP Work/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const ompExecutable = join(fixtureRoot, 'omp-fixture.cjs')
    renameSync(`${ompExecutable}.pending`, ompExecutable)
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await expect(page.getByText('OMP not detected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh harnesses' }).click()
    await expect(page.getByText('OMP is ready', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Connect to the newly installed harness')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'omp-runtime-args.json'))).toBe(true)
  })

  test('opens Harness settings from the no-harness recovery prompt', async () => {
    await expect(page.getByRole('heading', { name: 'No Pi family harness detected' })).toBeVisible()
    await expect(page.getByText('Install one to get started.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Take me there' }).click()
    await expect(page.getByRole('heading', { name: 'Harness', exact: true, level: 1 })).toBeVisible()
    const refresh = page.getByRole('button', { name: 'Refresh harnesses' })
    await expect(refresh).toBeVisible()
    await expect(page.getByLabel('Pi executable override')).toBeVisible()
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('applies themed native select colors and restores system appearance', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    const nativeSelectTheme = () => page.evaluate(() => {
      const select = document.createElement('select')
      const option = document.createElement('option')
      option.textContent = 'Theme probe'
      select.append(option)
      document.body.append(select)
      const root = getComputedStyle(document.documentElement)
      const selectStyle = getComputedStyle(select)
      const optionStyle = getComputedStyle(option)
      const result = {
        scheme: selectStyle.colorScheme,
        optionColor: optionStyle.color,
        optionBackground: optionStyle.backgroundColor,
        themeColor: root.getPropertyValue('--text').trim(),
        themeBackground: root.getPropertyValue('--surface-raised').trim(),
      }
      select.remove()
      return result
    })
    await page.getByRole('button', { name: /Light/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await nativeSelectTheme()).toMatchObject({
      scheme: 'light',
      optionColor: 'rgb(32, 32, 30)',
      optionBackground: 'rgb(255, 255, 255)',
      themeColor: '#20201e',
      themeBackground: '#ffffff',
    })
    await page.getByRole('button', { name: /Dark/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await nativeSelectTheme()).toMatchObject({
      scheme: 'dark',
      optionColor: 'rgb(241, 241, 238)',
      optionBackground: 'rgb(34, 34, 32)',
      themeColor: '#f1f1ee',
      themeBackground: '#222220',
    })
    await page.getByRole('button', { name: /System/ }).click()
  })

  test('increases interface text within the bounded appearance choices', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByRole('radio', { name: 'Larger', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Larger', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBeCloseTo(1.15, 2)

    await page.setViewportSize({ width: 480, height: 700 })
    const fits = await page.locator('.settings-row--text-size').evaluate((row) => row.scrollWidth <= row.clientWidth)
    expect(fits).toBe(true)
    await page.setViewportSize({ width: 1440, height: 920 })
    await page.getByRole('radio', { name: 'Default', exact: true }).click()
    await expect.poll(async () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBeCloseTo(1.1, 2)
  })

  test('preserves a rejected shell draft while rolling back the committed setting', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    const shell = page.getByLabel('Shell executable')
    const rejectedDraft = '/definitely/not-an-executable'
    await expect(shell).toHaveValue('/bin/zsh')
    await shell.fill(rejectedDraft)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('alert')).toHaveCount(0)

    await shell.press('Enter')

    const inlineError = page.getByRole('alert').filter({ hasText: /setting could not be saved/i })
    await expect(inlineError).toBeVisible()
    await expect(shell).toHaveAttribute('aria-invalid', 'true')
    await expect(shell).toHaveAttribute('aria-describedby', await inlineError.getAttribute('id') ?? '')
    await expect(page.locator('.toast')).toContainText(/shell is not executable/i)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => window.prime.settings.get().then((settings) => settings.terminalShell))).toBe('/bin/zsh')

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    await expect(page.locator('.settings-content input.mono')).toHaveValue('/bin/zsh')
  })

  test('uses the persisted selected pet for realtime voice after a full restart', async () => {
    const desktopPet = page.getByRole('button', { name: /Orb, draggable GooeyPi pet/ })
    await expect(desktopPet).toBeVisible()
    await desktopPet.hover()
    await expect(desktopPet).not.toHaveAttribute('title')
    await expect(page.locator('.desktop-pet__name')).toHaveCount(0)
    const idlePetGap = await page.locator('.desktop-pet').evaluate((surface) => {
      const avatar = surface.querySelector<HTMLElement>('.desktop-pet__avatar')!.getBoundingClientRect()
      const waveform = surface.querySelector<HTMLButtonElement>('[aria-label="Open realtime voice"]')!.getBoundingClientRect()
      return waveform.top - avatar.bottom
    })
    expect(idlePetGap).toBeGreaterThanOrEqual(-8)
    expect(idlePetGap).toBeLessThanOrEqual(1)
    await page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' }).click()
    await expect(page.getByRole('complementary', { name: 'Realtime voice session' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Orb, draggable GooeyPi pet/ })).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
    await page.getByRole('complementary', { name: 'Realtime voice session' }).getByRole('button', { name: 'Close realtime voice' }).click()

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Pets', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Pets', exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^Orb Built/ })).toBeChecked()
    await page.getByRole('radio', { name: /^GooeyPi Built/ }).click()
    await expect(page.getByRole('radio', { name: /^GooeyPi Built/ })).toBeChecked()
    await expect(page.getByRole('heading', { name: 'Codex Pets' })).toBeVisible()
    const showPet = page.getByRole('checkbox', { name: 'Show desktop pet' })
    await showPet.focus()
    await showPet.press('Space')
    await expect(showPet).not.toBeChecked()
    await expect(page.locator('.desktop-pet')).toHaveCount(0)
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings).toMatchObject({ petEnabled: false, petId: 'gooey-pi' })

    await relaunchHermeticApp()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })

    await expect(page.locator('.desktop-pet')).toHaveCount(0)
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' }).click()
    const realtimePet = page.getByRole('complementary', { name: 'Realtime voice session' })
    await expect(realtimePet.getByRole('button', { name: /GooeyPi, draggable GooeyPi pet/ })).toBeVisible()
    await expect(realtimePet.locator('.pet-sprite img')).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
  })

  test('installs, disables, and restores Pi MCP support from its directory toggle', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    await page.getByRole('button', { name: 'Capabilities', exact: true }).click()

    const enable = page.getByRole('button', { name: 'Enable Pi MCP Adapter' })
    await expect(enable).toHaveAttribute('aria-pressed', 'false')
    await enable.click()
    await expect(page.getByRole('button', { name: 'Disable Pi MCP Adapter' })).toHaveAttribute('aria-pressed', 'true')
    const settingsPath = join(fixtureRoot, 'home', '.pi', 'agent', 'settings.json')
    await expect.poll(() => JSON.parse(readFileSync(settingsPath, 'utf8')).packages).toContain('npm:pi-mcp-adapter')
    await expect(page.getByRole('status').filter({ hasText: 'Pi MCP Adapter installed.' })).toBeVisible()

    await page.getByRole('button', { name: 'Pi Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Prime Work/ }).click()
    await expect(page.getByText('Pi MCP Adapter installed.')).toHaveCount(0)
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    await expect(page.getByRole('heading', { name: 'Extend Pi' })).toBeVisible()

    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Add a Pi capability' })
    await chooser.getByRole('button', { name: /Add MCP/ }).click()
    const addDialog = page.getByRole('dialog', { name: 'Add MCP server' })
    await addDialog.getByLabel('Server name').fill('docs')
    await addDialog.getByLabel('Executable').fill('mcp-docs')
    await addDialog.getByLabel(/Arguments/).fill('--local')
    await addDialog.getByRole('button', { name: 'Save local server' }).click()
    const mcpPath = join(fixtureRoot, 'home', '.pi', 'agent', 'mcp.json')
    await expect.poll(() => existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.docs : null).toEqual({ command: 'mcp-docs', args: ['--local'], enabled: true })

    await addDialog.getByRole('button', { name: 'Close' }).click()

    await page.getByRole('button', { name: 'Disable Pi MCP Adapter' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Disable Pi MCP Adapter?' })
    await expect(confirmation).toContainText('Are you sure?')
    await confirmation.getByRole('button', { name: 'Yes, disable' }).click()
    await expect(page.getByRole('button', { name: 'Enable Pi MCP Adapter' })).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => JSON.parse(readFileSync(settingsPath, 'utf8')).packages).toEqual([
      { source: 'npm:pi-mcp-adapter', extensions: [], skills: [], prompts: [], themes: [] },
    ])

    await page.getByRole('button', { name: 'Enable Pi MCP Adapter' }).click()
    await expect(page.getByRole('button', { name: 'Disable Pi MCP Adapter' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => JSON.parse(readFileSync(settingsPath, 'utf8')).packages).toContain('npm:pi-mcp-adapter')
  })

  test('shows built-in Prime MCPs without inspecting or changing authorization', async () => {
    await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
    const notion = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Notion', exact: true }) })
    await expect(notion).toContainText('Configuration and authorization are managed directly in Prime Agent')
    await expect(notion.getByLabel('Externally managed Notion')).toBeVisible()
    await expect(notion.getByRole('button', { name: 'Disable Notion' })).toHaveCount(0)
    await expect(notion.getByRole('button', { name: 'Forget authorization for Notion' })).toHaveCount(0)
    const notionBox = await notion.boundingBox()
    const controlBox = await notion.getByLabel('Externally managed Notion').boundingBox()
    if (!notionBox || !controlBox) throw new Error('Notion capability controls did not render')
    expect(Math.abs(notionBox.x + notionBox.width - controlBox.x - controlBox.width)).toBeLessThanOrEqual(6)
    await expect(notion.getByRole('button', { name: 'Remove Notion' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove Ask user' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove Browser' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove Computer Use | TryCUA' })).toHaveCount(0)
    expect(JSON.parse(readFileSync(join(fixtureRoot, 'home', '.prime', 'agent', 'auth.json'), 'utf8'))['mcp:notion'].access).toBe('fixture-token')
  })

})
