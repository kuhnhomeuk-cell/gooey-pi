import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachHermeticHooks, currentFixture, expect, fixtureRoot, fixtureSessionFile, page, test } from './fixtures/desktop'

test.describe('Prime Work sessions', () => {
  test.describe.configure({ mode: 'parallel' })
  attachHermeticHooks()

  test('steers the active turn with Ctrl+Enter', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('stay busy while I steer')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop Prime' })).toBeVisible()

    await composer.fill('send this queued task now')
    await composer.press('Enter')
    const queuedTray = page.getByRole('region', { name: 'Queued messages' })
    await queuedTray.locator('.composer-queue__item').hover()
    await expect(queuedTray.locator('.composer-queue__actions')).toHaveCSS('opacity', '1')
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(1)
    const sendImmediately = queuedTray.getByRole('button', { name: /^Send queued message immediately:/ })
    await expect(sendImmediately).toHaveAttribute('title', 'Send queued message immediately')
    await sendImmediately.click()
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(0)
    const queuedSteerMarker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => existsSync(queuedSteerMarker)).toBe(true)
    expect(JSON.parse(readFileSync(queuedSteerMarker, 'utf8'))).toMatchObject({ type: 'steer', message: 'send this queued task now' })
    await composer.fill('change direction now')
    await composer.press('Control+Enter')
    await expect(page.locator('.message--user').filter({ hasText: 'change direction now' })).toBeVisible()
    const marker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => {
      if (!existsSync(marker)) return ''
      return JSON.parse(readFileSync(marker, 'utf8')).message
    }).toBe('change direction now')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ type: 'steer', message: 'change direction now' })
    await expect(composer).toHaveValue('')
  })

  test('centers the compact context-usage dial', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const dial = page.locator('.context-usage-dial')
    await expect(dial).toBeVisible()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Refresh context usage')
    await composer.press('Enter')
    await expect(dial).toHaveText('12')
    const offset = await dial.evaluate((node) => {
      const textNode = node.querySelector('span')?.firstChild
      if (!textNode) throw new Error('Missing context dial text')
      const dialRect = node.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(textNode)
      const textRect = range.getBoundingClientRect()
      return {
        x: (textRect.left + textRect.right - dialRect.left - dialRect.right) / 2,
        y: (textRect.top + textRect.bottom - dialRect.top - dialRect.bottom) / 2,
        size: dialRect.width,
      }
    })
    expect(offset.size).toBeCloseTo(26.4, 1)
    expect(Math.abs(offset.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(offset.y)).toBeLessThanOrEqual(0.5)
  })

  test('picks, previews, and removes an image in the composer', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const imagePath = join(fixtureRoot, 'picker.png')
    writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

    await page.getByRole('button', { name: 'Add context' }).click()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('option', { name: /Add files/ }).click()
    await (await fileChooser).setFiles(imagePath)
    await expect(page.locator('.composer-attachment').filter({ hasText: 'picker.png' })).toBeVisible()
    await expect(page.locator('.composer p[role="status"]')).toHaveText('1 file attached.')
    await page.getByRole('button', { name: 'Remove picker.png' }).click()
    await expect(page.locator('.composer-attachment').filter({ hasText: 'picker.png' })).toHaveCount(0)
  })

  test('collapses composer selectors and keeps the checkout menu inside a narrow conversation pane', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await page.locator('.conversation-column').evaluate((node) => {
      node.style.flex = '0 0 560px'
      const pane = node.querySelector<HTMLElement>('.conversation-pane')
      if (pane) pane.style.minWidth = '0'
    })

    const model = page.locator('.select-control').filter({ has: page.getByRole('combobox', { name: 'Model' }) })
    const reasoning = page.locator('.select-control').filter({ has: page.getByRole('combobox', { name: 'Reasoning effort' }) })
    await expect(model.locator('.select-control__chevron')).toHaveCSS('display', 'none')
    await expect(reasoning.locator('.select-control__chevron')).toHaveCSS('display', 'none')
    await expect(model.getByRole('combobox')).toHaveCSS('opacity', '1')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '1')

    await page.locator('.conversation-column').evaluate((node) => { node.style.flex = '0 0 300px' })
    await expect(model.getByRole('combobox')).toHaveCSS('opacity', '0')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '0')
    await expect(model.locator('.select-control__icon')).not.toHaveCSS('display', 'none')
    await expect(reasoning.locator('.select-control__icon')).not.toHaveCSS('display', 'none')

    const controlBounds = await page.locator('.composer__footer').evaluate((footer) => {
      const controls = footer.querySelector<HTMLElement>('.composer__controls')!
      const actions = footer.querySelector<HTMLElement>('.composer__actions')!
      const controlsRect = controls.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return { controlsRight: controlsRect.right, actionsLeft: actionsRect.left }
    })
    expect(controlBounds.controlsRight).toBeLessThanOrEqual(controlBounds.actionsLeft)

    await page.getByRole('button', { name: /^Checkout:/ }).click()
    const menuBounds = await page.getByRole('menu', { name: 'Git worktrees' }).evaluate((menu) => {
      const menuRect = menu.getBoundingClientRect()
      const footerRect = menu.closest('.composer__footer')!.getBoundingClientRect()
      return { menuLeft: menuRect.left, menuRight: menuRect.right, footerLeft: footerRect.left, footerRight: footerRect.right }
    })
    expect(menuBounds.menuLeft).toBeGreaterThanOrEqual(menuBounds.footerLeft - 0.5)
    expect(menuBounds.menuRight).toBeLessThanOrEqual(menuBounds.footerRight + 0.5)
  })

  test('switches to OMP Work and lists the OMP session catalog, then returns to Prime', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    const ompBrand = page.getByRole('button', { name: 'OMP Work — switch harness' })
    await expect(ompBrand).toBeVisible()
    await expect(page.locator('.sidebar__brand .omp-mark')).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Capabilities' })).toBeVisible()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    await expect(page.getByRole('main').getByText('OMP fixture reply.')).toBeVisible()
    await ompBrand.click()
    await page.getByRole('menuitemradio', { name: /Prime Work/ }).click()
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
  })

  test('switches to Pi Work and lists the pi session catalog, then returns to Prime', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    const piBrand = page.getByRole('button', { name: 'Pi Work — switch harness' })
    await expect(piBrand).toBeVisible()
    await expect(page.locator('.sidebar__brand .pi-mark')).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Pi hermetic fixture' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Capabilities' })).toBeVisible()
    await page.locator('.session-row__title').filter({ hasText: 'Pi hermetic fixture' }).click()
    await expect(page.getByRole('main').getByText('Pi fixture reply.')).toBeVisible()
    await piBrand.click()
    await page.getByRole('menuitemradio', { name: /Prime Work/ }).click()
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toBeVisible()
  })

  test('closes realtime voice before switching harnesses', async () => {
    await page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' }).click()
    const petSurface = page.locator('.desktop-pet')
    await expect(petSurface.getByRole('button', { name: 'Mute realtime voice' })).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await expect(petSurface.getByRole('button', { name: 'Mute realtime voice' })).toHaveCount(0)
    await expect(petSurface.getByRole('button', { name: 'Open realtime voice' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'OMP Work — switch harness' })).toBeVisible()
  })

  test('keeps thread order stable and mutes acknowledged failure indicators', async () => {
    const titles = page.locator('.session-row__title')
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    await expect(titles.nth(1)).toHaveText('Primary workspace fixture')
    const primaryFile = join(fixtureSessionFile, '..', 'primary.jsonl')
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-background-assistant', parentId: 'primary-message', timestamp: '2027-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Background work failed.', stopReason: 'error' },
    })}\n`)

    const primaryRow = page.locator('.session-row-wrap').filter({ hasText: 'Primary workspace fixture' })
    await expect(primaryRow).toHaveClass(/has-attention/)
    const activityCount = page.locator('.sidebar__primary button[title="Activity"] .nav-count')
    await expect(activityCount).toHaveText('1')
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    const attentionColor = await primaryRow.evaluate((node) => getComputedStyle(node).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [])
    expect(attentionColor.length).toBeGreaterThanOrEqual(3)
    expect(attentionColor[2]).toBeGreaterThan(attentionColor[1])

    const failureMark = primaryRow.locator('.session-status-mark--failed')
    const activeFailureColor = await failureMark.locator('> span').evaluate((node) => getComputedStyle(node).backgroundColor)

    await primaryRow.locator('.session-row').click()
    await expect(primaryRow).not.toHaveClass(/has-attention/)
    await expect(primaryRow).toHaveClass(/session-row-wrap--failed/)
    await expect(failureMark).toHaveAttribute('title', 'Failed — notification cleared')
    await expect.poll(() => failureMark.locator('> span').evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(activeFailureColor)
    await expect(activityCount).toHaveCount(0)
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-new-user', parentId: 'primary-background-assistant', timestamp: '2028-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Move this thread now.' },
    })}\n`)
    await expect(titles.nth(0)).toHaveText('Primary workspace fixture')
  })

  test('clears individual and all Activity notifications persistently', async () => {
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    const primaryActivity = page.locator('.activity-row').filter({ hasText: 'Primary workspace fixture' })
    const fixtureActivity = page.locator('.activity-row').filter({ hasText: 'Hermetic desktop fixture' })
    await expect(primaryActivity).toBeVisible()
    await expect(fixtureActivity).toBeVisible()

    const clearPrimary = primaryActivity.getByRole('button', { name: 'Clear Primary workspace fixture activity' })
    await primaryActivity.hover()
    await expect(clearPrimary).toHaveCSS('opacity', '1')
    await clearPrimary.click()
    await expect(primaryActivity).toHaveCount(0)
    await expect(fixtureActivity).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const cleared = JSON.parse(window.localStorage.getItem('prime-work.cleared-activity') ?? '{}') as Record<string, string>
      return cleared['primary-session']
    })).toBeTruthy()

    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.locator('.activity-row').filter({ hasText: 'Primary workspace fixture' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
  })

  test('removes archived chats from Activity and clears their notifications', async () => {
    const primaryFile = join(fixtureSessionFile, '..', 'primary.jsonl')
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-archive-failure', parentId: 'primary-message', timestamp: '2027-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Archive this failed work.', stopReason: 'error' },
    })}\n`)

    const primaryRow = page.locator('.session-row-wrap').filter({ hasText: 'Primary workspace fixture' })
    await expect(primaryRow).toHaveClass(/has-attention/)
    const activityCount = page.locator('.sidebar__primary button[title="Activity"] .nav-count')
    await expect(activityCount).toHaveText('1')

    await primaryRow.getByTitle('Archive Primary workspace fixture').click()
    await primaryRow.getByTitle('Confirm archive Primary workspace fixture').click()
    await expect(primaryRow).toHaveCount(0)
    await expect(activityCount).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => {
      const cleared = JSON.parse(window.localStorage.getItem('prime-work.cleared-session-attention') ?? '{}') as Record<string, string>
      return cleared['primary-session']
    })).toBeTruthy()

    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await expect(page.getByText('Primary workspace fixture', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Archived', exact: true })).toHaveCount(0)
  })

  test('stops a dev server launched from the thread terminal when archived', async () => {
    const sessionRow = page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' })
    await sessionRow.locator('.session-row').click()
    await page.getByLabel(/Toggle terminal/).click()
    const terminal = page.locator('.terminal-drawer:not([hidden])')
    const input = terminal.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    const pidFile = join(fixtureRoot, 'archived-dev-server.pid')
    await input.click()
    await page.keyboard.type(`/bin/sh -c 'echo $$ > ${pidFile}; while true; do /bin/sleep 1; done'`)
    await page.keyboard.press('Enter')
    await expect.poll(() => existsSync(pidFile)).toBe(true)
    const serverPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(serverPid).toBeGreaterThan(0)

    try {
      await sessionRow.getByTitle('Archive Hermetic desktop fixture').click()
      await sessionRow.getByTitle('Confirm archive Hermetic desktop fixture').click()

      await expect(sessionRow).toHaveCount(0)
      await expect(page.locator('.terminal-drawer')).toHaveCount(0)
      await expect.poll(() => {
        try { process.kill(serverPid, 0); return false } catch { return true }
      }).toBe(true)
    } finally {
      try { process.kill(serverPid, 'SIGKILL') } catch { /* archive cleanup succeeded */ }
    }
  })

  test('defers a reply to a session that is active outside Prime Work', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Queue this follow-up from Prime Work')
    await composer.press('Enter')

    const queuedMessages = page.getByRole('region', { name: 'Queued messages' })
    await expect(queuedMessages.locator('.composer-queue__item')).toHaveCount(1)
    await expect(queuedMessages).toContainText('Queue this follow-up from Prime Work')
    expect(existsSync(join(fixtureRoot, 'follow-up-args.json'))).toBe(false)
    expect(existsSync(join(fixtureRoot, 'follow-up-ack.json'))).toBe(false)
    await expect(page.locator('.transcript').getByText('The external Prime Agent received the queued reply.')).toHaveCount(0)
    await expect(page.getByText(/Prime Agent RPC exited|Request failed/)).toHaveCount(0)

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.getByRole('region', { name: 'Queued messages' })).toContainText('Queue this follow-up from Prime Work')
  })

  test('reflects an external JSONL append without reselecting the live session', async () => {
    await expect(page.locator('.transcript').getByText('Hermetic desktop fixture', { exact: true })).toBeVisible()
    const selectedSession = page.locator('.session-row-wrap.is-selected')
    await expect(selectedSession).toHaveCount(1)

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const reasoning = `External live reasoning ${nonce}`
    const answer = `External live answer ${nonce}`
    const timestamp = new Date().toISOString()
    appendFileSync(fixtureSessionFile, `${JSON.stringify({
      type: 'message',
      id: `fixture-external-${nonce}`,
      parentId: 'fixture-goal-summary',
      timestamp,
      message: {
        role: 'assistant',
        timestamp,
        content: [
          { type: 'thinking', thinking: reasoning },
          { type: 'toolCall', id: `fixture-tool-${nonce}`, name: 'fixture_external_tool', arguments: { nonce } },
          { type: 'text', text: answer },
        ],
      },
    })}
`)

    await expect(page.locator('.transcript').getByText(reasoning, { exact: true })).toHaveCount(1)
    await expect(page.locator('.transcript').getByText(answer, { exact: true })).toHaveCount(1)
    await expect(page.locator('.activity-line--tool')).toContainText('fixture_external_tool')
    await expect(page.locator('.work-disclosure__button')).toHaveCount(0)
    await expect(selectedSession).toHaveCount(1)
  })

  test('keeps session options visible and starts a new session from a hovered project', async () => {
    const sessionOptions = page.locator('.session-row__more').first()
    await expect(sessionOptions).toBeVisible()
    await expect.poll(() => sessionOptions.evaluate((node) => getComputedStyle(node).opacity)).toBe('1')

    const projectRow = page.locator('.project-row').first()
    const projectSession = projectRow.getByRole('button', { name: /^New session in / })
    await expect.poll(() => projectSession.evaluate((node) => getComputedStyle(node).opacity)).toBe('0')
    await expect.poll(async () => {
      await projectRow.hover()
      return projectSession.evaluate((node) => getComputedStyle(node).opacity)
    }).toBe('1')
    await projectSession.click()

    await expect(projectRow).toHaveClass(/is-selected/)
    await expect(page.locator('.session-row-wrap.is-selected')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toHaveValue('')
  })

  test('keeps wrapped editing native and aligned through classic scrollbar overflow', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await page.addStyleTag({ content: `
      .composer-input > textarea { overflow-y: scroll !important; }
      .composer-input > textarea::-webkit-scrollbar { width: 28px; }
    ` })

    await composer.fill('@Ownership')
    const reference = page.getByRole('option', { name: /@Ownership peer fixture/ })
    await expect(reference).toBeVisible()
    await expect(composer).toHaveAttribute('aria-autocomplete', 'list')
    await reference.click()

    const longToken = 'unbroken-token-'.repeat(18)
    const draft = `@Ownership peer fixture\nFirst wrapped line ${'with words '.repeat(22)}\nEDITME ${longToken}\n${'final line '.repeat(30)}`
    await composer.fill(draft)
    const editStart = draft.indexOf('EDITME')
    await composer.evaluate((element, start) => {
      const textarea = element as HTMLTextAreaElement
      textarea.focus()
      textarea.setSelectionRange(start, start + 'EDITME'.length)
    }, editStart)
    await composer.pressSequentially('replacement')
    await expect(composer).toHaveValue(draft.replace('EDITME', 'replacement'))

    const layout = await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      textarea.scrollTop = textarea.scrollHeight
      textarea.dispatchEvent(new Event('scroll'))
      const style = getComputedStyle(textarea)
      return {
        hasVerticalOverflow: textarea.scrollHeight > textarea.clientHeight,
        scrollbarWidth: textarea.offsetWidth - textarea.clientWidth,
        scrollTop: textarea.scrollTop,
        color: style.color,
        textFillColor: style.webkitTextFillColor,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        mirrorCount: textarea.parentElement?.querySelectorAll('.composer-input__highlight').length ?? -1,
      }
    })
    expect(layout.hasVerticalOverflow).toBe(true)
    expect(layout.scrollbarWidth).toBeGreaterThanOrEqual(24)
    expect(layout.scrollTop).toBeGreaterThan(0)
    expect(layout.selectionStart).toBe(layout.selectionEnd)
    expect(layout.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.textFillColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.mirrorCount).toBe(0)

    await page.emulateMedia({ forcedColors: 'active' })
    const forcedColorText = await composer.evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.color, textFillColor: style.webkitTextFillColor }
    })
    expect(forcedColorText.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(forcedColorText.textFillColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  test('copies a session id and routes an @session mention without exposing its UUID block', async () => {
    await page.evaluate(() => {
      const target = window as Window & { __copiedSessionId?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { target.__copiedSessionId = text } },
      })
    })
    const selected = page.locator('.session-row-wrap.is-selected .session-row')
    await selected.click({ button: 'right' })
    const sessionMenu = page.getByLabel('Session options')
    await sessionMenu.getByRole('button', { name: 'Copy session UUID' }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedSessionId?: string }).__copiedSessionId)).toBe('fixture-session')

    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Coordinate with @Ownership')
    const reference = page.getByRole('option', { name: /@Ownership peer fixture/ })
    await expect(reference).toBeVisible()
    await reference.click()
    const caret = await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      return { start: textarea.selectionStart, end: textarea.selectionEnd, length: textarea.value.length }
    })
    expect(caret).toEqual({ start: caret.length, end: caret.length, length: caret.length })
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await composer.pressSequentially('about ownership')
    await expect(composer).toHaveValue('Coordinate with @Ownership peer fixture about ownership')
    await composer.press('Enter')

    const marker = join(fixtureRoot, 'prompt-args.json')
    await expect.poll(() => existsSync(marker)).toBe(true)
    const sent = JSON.parse(readFileSync(marker, 'utf8')) as { message: string }
    expect(sent.message).toContain('Coordinate with @Ownership peer fixture about ownership')
    expect(sent.message).toContain('prime session UUID 019fdf24-cccc-7000-8000-000000000003')
    expect(sent.message).toContain('===== BEGIN GOOEYPI SESSION REFERENCES =====')
    appendFileSync(fixtureSessionFile, `${JSON.stringify({
      type: 'message', id: 'fixture-session-reference', parentId: 'fixture-goal-summary', timestamp: new Date().toISOString(),
      message: { role: 'user', content: sent.message, timestamp: new Date().toISOString() },
    })}\n`)
    await page.locator('.session-row-wrap').filter({ hasText: 'Ownership peer fixture' }).locator('.session-row').click()
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const userMessage = page.locator('.message--user').filter({ hasText: 'Coordinate with @Ownership peer fixture about ownership' })
    await expect(userMessage).toBeVisible()
    await expect(userMessage).not.toContainText('019fdf24-cccc-7000-8000-000000000003')
    await expect(userMessage).not.toContainText('GOOEYPI SESSION REFERENCES')
    const linkedMention = userMessage.getByRole('button', { name: 'Open session Ownership peer fixture' })
    await expect(linkedMention).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(linkedMention).toHaveCSS('border-top-width', '0px')
    await linkedMention.click()
    await expect(page.locator('.session-row-wrap').filter({ hasText: 'Ownership peer fixture' })).toHaveClass(/is-selected/)
  })

  test('removes a project from the sidebar through its context menu', async () => {
    const projectRow = page.locator('.project-row').first()
    await expect(projectRow).toBeVisible()
    await expect(page.locator('.sidebar__primary .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.project-row__new-session .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.sidebar__section-heading .lucide-folder-plus')).toHaveCount(1)
    await expect(page.getByTitle('New session (⌘N)')).toHaveCount(2)
    await expect(page.getByTitle('Add project')).toHaveCount(1)
    await expect(projectRow.getByTitle('New session in Multi-folder fixture')).toHaveCount(1)
    await expect(page.getByTitle('Archive Hermetic desktop fixture')).toHaveCount(1)

    await projectRow.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Project options for Multi-folder fixture' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Remove project' }).click()

    const dialog = page.getByRole('dialog', { name: 'Remove project' })
    await expect(dialog).toContainText('The folder and saved sessions will not be deleted.')
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.locator('.project-row')).toHaveCount(0)
    expect(existsSync(join(fixtureRoot, 'project'))).toBe(true)
  })

  test('renders agent handoffs and goal summaries as collapsed readable disclosures', async () => {
    const agentDisclosure = page.getByRole('button', { name: 'Message from agent: fixture-reviewer' })
    const goalDisclosure = page.getByRole('button', { name: 'Goal summary' })
    await expect(agentDisclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(goalDisclosure).toHaveAttribute('aria-expanded', 'false')

    await agentDisclosure.click()
    await goalDisclosure.click()
    await expect(page.locator('.agent-message__content')).toContainText('Fixture review complete.')
    await expect(page.locator('.goal-message__content')).toContainText('Verify the readable blue goal summary.')
    await expect(page.getByText(/Envelope metadata|Fixture control envelope/)).toHaveCount(0)
  })

  test('copies a specific user or agent message from the action directly below it', async () => {
    await page.evaluate(() => {
      const target = window as Window & { __copiedMessage?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { target.__copiedMessage = text } },
      })
    })

    const userMessage = page.locator('.message--user').filter({ hasText: 'Hermetic desktop fixture' })
    await userMessage.hover()
    const userCopy = userMessage.locator('.message-actions button')
    await expect(userCopy).toHaveAccessibleName('Copy user message')
    await expect(userCopy).toBeVisible()
    await userCopy.click()
    await expect(userCopy).toHaveAccessibleName('Copied user message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Hermetic desktop fixture')

    const agentMessage = page.locator('.message--agent')
    await expect(agentMessage.getByRole('button', { name: 'Copy agent message' })).toHaveCount(0)
    await agentMessage.getByRole('button', { name: 'Message from agent: fixture-reviewer' }).click()
    await agentMessage.hover()
    const agentCopy = agentMessage.locator('.message-actions button')
    await expect(agentCopy).toHaveAccessibleName('Copy agent message')
    await expect(agentCopy).toBeVisible()
    await agentCopy.click()
    await expect(agentCopy).toHaveAccessibleName('Copied agent message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Fixture review complete. The readable agent response is available here.')
  })

  test('supports keyboard navigation for composer suggestions', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('/')
    const options = page.locator('.composer-menu').getByRole('option')
    await expect(options).toHaveCount(5)
    await expect(composer).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue('/plan ')
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toHaveValue('')
  })

  test('routes the Prime MCP slash command to Capabilities without starting an agent turn', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('/mcp')
    await expect(page.locator('.composer-menu').getByRole('option', { name: /\/mcp View MCP integrations/ })).toBeVisible()
    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(page.getByRole('heading', { name: /Extend/ })).toBeVisible()
    await expect(page.getByText('Manage packages, extensions, MCP servers, and reusable skills for this harness.')).toBeVisible()
    expect(existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(false)
  })

  test('round-trips a grouped Prime ask_user questionnaire', async () => {
    await page.evaluate(() => window.prime.settings.update({ askUserEnabled: true }))
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Ask me two questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('.work-disclosure__rail')).toBeVisible()
    const workStatus = page.locator('.work-disclosure__status')
    await expect(workStatus).toHaveAttribute('role', 'status')
    await expect(workStatus).toContainText('Working')
    await expect(page.locator('.activity-line--reasoning')).toContainText('Reviewing the available release channels')
    await expect(page.locator('.thinking-dots > span')).toHaveCount(3)
    await expect(page.locator('.work-disclosure__button')).toHaveCount(0)
    await expect(dialog).toContainText('Question 1 of 2')
    const context = dialog.getByRole('textbox', { name: 'Additional context' })
    await context.fill('For the pilot')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Safety' }).click()
    await expect(dialog).toContainText('Submit answers')
    const submitStep = dialog.locator('.extension-questionnaire__progress button').last()
    await expect(submitStep).toHaveAttribute('aria-current', 'step')
    await expect(submitStep).toBeFocused()
    await page.keyboard.press('Control+ArrowLeft')
    await expect(dialog).toContainText('Question 2 of 2')
    await expect(dialog.getByRole('option', { name: 'Safety' })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+ArrowLeft')
    await expect(dialog).toContainText('Question 1 of 2')
    await expect(dialog.getByRole('textbox', { name: 'Additional context' })).toHaveValue('For the pilot')
    await page.keyboard.press('Control+ArrowRight')
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Other (type your own answer)' }).click()
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('A custom priority')
    await page.keyboard.press('Enter')
    await expect(dialog).toContainText('Submit answers')
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    expect(JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8'))).toMatchObject({
      type: 'prompt',
      message: 'Ask me two questions',
    })
    const runtimeArgs = JSON.parse(readFileSync(join(fixtureRoot, 'prime-runtime-args.json'), 'utf8')) as string[]
    expect(runtimeArgs).toContain(join(process.cwd(), 'assets', 'extensions', 'omp-work-ask-user.ts'))
    const worked = page.locator('.work-disclosure__button')
    await expect(worked).toContainText(/^Worked for /)
    await expect(worked).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.activity-line--reasoning')).toHaveCount(0)
    await worked.click()
    await expect(page.locator('.activity-line--question')).toContainText('What should I optimize for?')

    const completedRow = page.locator('.session-row-wrap').filter({ hasText: 'Post-completion catalog refresh' })
    await expect(completedRow).toHaveCount(1)
    await expect(completedRow).toHaveClass(/session-row-wrap--complete/)
    await expect(completedRow).toHaveClass(/is-selected/)
    await expect(completedRow).not.toHaveClass(/has-attention/)
    await expect(page.getByRole('status', { name: 'A session turn ended or needs attention' })).toHaveCount(0)
    await completedRow.locator('.session-row').click()
  })

  test('injects ask_user into OMP and answers its grouped questionnaire in the app', async () => {
    await page.evaluate(() => window.prime.settings.update({ askUserEnabled: true }))
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()

    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Ask me two OMP questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Which OMP release channel?')
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('OMP app verification')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toContainText('What should OMP optimize for?')
    await dialog.getByRole('option', { name: 'Safety' }).click()
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const valuesPath = join(fixtureRoot, 'omp-questionnaire-values.json')
    await expect.poll(() => existsSync(valuesPath)).toBe(true)
    expect(JSON.parse(readFileSync(valuesPath, 'utf8'))).toEqual({
      'omp-fixture-question-1': JSON.stringify({ answer: 'Beta', answerSource: 'option', context: 'OMP app verification' }),
      'omp-fixture-question-2': JSON.stringify({ answer: 'Safety', answerSource: 'option' }),
    })
    const runtimeArgs = JSON.parse(readFileSync(join(fixtureRoot, 'omp-runtime-args.json'), 'utf8')) as string[]
    const injectedExtensions = runtimeArgs.flatMap((value, index) => value === '--extension' ? [runtimeArgs[index + 1]] : [])
    expect(injectedExtensions).toContain(join(process.cwd(), 'assets', 'extensions', 'omp-work-ask-user.ts'))
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.getByText(/OMP RPC exited|Request failed/)).toHaveCount(0)
  })

  test('injects ask_user into Pi and answers its grouped questionnaire in the app', async () => {
    await page.evaluate(() => window.prime.settings.update({ askUserEnabled: true }))
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    await page.locator('.session-row__title').filter({ hasText: 'Pi hermetic fixture' }).click()

    const composer = page.getByRole('combobox', { name: 'Message Pi' })
    await composer.fill('Ask me two Pi questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Which Pi release channel?')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toContainText('What should Pi optimize for?')
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('Pi app verification')
    await dialog.getByRole('option', { name: 'Safety' }).click()
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const valuesPath = join(fixtureRoot, 'pi-questionnaire-values.json')
    await expect.poll(() => existsSync(valuesPath)).toBe(true)
    expect(JSON.parse(readFileSync(valuesPath, 'utf8'))).toEqual({
      'pi-fixture-question-1': JSON.stringify({ answer: 'Beta', answerSource: 'option' }),
      'pi-fixture-question-2': JSON.stringify({ answer: 'Safety', answerSource: 'option', context: 'Pi app verification' }),
    })
    const runtime = JSON.parse(readFileSync(join(fixtureRoot, 'pi-runtime-args.json'), 'utf8')) as { args: string[]; cwd: string }
    const injectedExtensions = runtime.args.flatMap((value, index) => value === '--extension' ? [runtime.args[index + 1]] : [])
    expect(injectedExtensions).toContain(join(process.cwd(), 'assets', 'extensions', 'omp-work-ask-user.ts'))
    expect(runtime.args).not.toContain('--cwd')
    if (!currentFixture) throw new Error('Missing hermetic fixture')
    expect(runtime.cwd).toBe(realpathSync(currentFixture.project))
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.getByText(/Pi RPC exited|Request failed/)).toHaveCount(0)
  })

  test('binds Git to a secondary workspace and clears stale paths during a folder switch', async () => {
    await page.getByRole('tab', { name: 'Changes' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await expect(page.getByRole('button', { name: /Stage$/ }).last()).toBeVisible()

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.file-changes')).not.toContainText('secondary-change.txt')
    await expect(page.locator('.file-changes')).toContainText('README.md')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Stage$/ }).last().click()
    await page.getByRole('button', { name: 'Staged', exact: true }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Unstage$/ }).last().click()
  })

  test('dismisses the file changes popup, disables it in settings, and undoes a file', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const changesCard = page.locator('.changes-card')
    await expect(changesCard).toBeVisible()
    await changesCard.getByRole('button', { name: 'Dismiss file changes' }).click()
    await expect(changesCard).toHaveCount(0)

    await page.keyboard.press('Meta+,')
    const popupToggle = page.getByRole('checkbox', { name: 'Show file changes popup' })
    await expect(popupToggle).toBeChecked()
    await popupToggle.focus()
    await popupToggle.press('Space')
    await expect(popupToggle).not.toBeChecked()
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).showFileChangesPopup)).toBe(false)
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.changes-card')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Changes' }).click()
    await page.locator('.file-changes > button').first().click()
    await page.getByRole('button', { name: 'Undo changes', exact: true }).click()
    const undoDialog = page.getByRole('dialog', { name: 'Undo file changes?' })
    await expect(undoDialog).toContainText('staged and unstaged changes')
    await undoDialog.getByRole('button', { name: 'Undo changes', exact: true }).click()
    await expect.poll(() => readFileSync(join(fixtureRoot, 'secondary-project', 'secondary-change.txt'), 'utf8')).toBe('base\n')
    await expect(page.locator('.file-changes')).toContainText('No unstaged changes.')
  })

  test('restores each session terminal without leaking it into another session', async () => {
    await page.getByLabel(/Toggle terminal/).click()
    const visibleDrawer = page.locator('.terminal-drawer:not([hidden])')
    const input = visibleDrawer.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('echo secondary-session-state')
    await page.keyboard.press('Enter')
    await expect(visibleDrawer.locator('.xterm-rows')).toContainText('secondary-session-state', { timeout: 8_000 })

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    const primaryDrawer = page.locator('.terminal-drawer:not([hidden])')
    const primaryInput = primaryDrawer.locator('.xterm-helper-textarea')
    await expect(primaryInput).toBeVisible()
    await primaryInput.click()
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect(primaryDrawer.locator('.xterm-rows')).toContainText(/prime-work-e2e-[^/]+\/project/, { timeout: 8_000 })
    await expect(primaryDrawer.locator('.xterm-rows')).not.toContainText('secondary-session-state')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText('secondary-session-state')
    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText(/prime-work-e2e-[^/]+\/project/)
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
  })

  test('opens independent terminal tabs inside the conversation column', async () => {
    const project = await page.evaluate(async () => {
      const projects = await window.prime.projects.list()
      const selected = projects[0]
      if (!selected) return null
      return selected.inferred ? window.prime.projects.grantInferred(selected.primaryFolder) : selected
    })
    expect(project).not.toBeNull()
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.locator('.terminal-drawer .xterm')).toBeVisible()
    await expect(page.locator('.terminal-live-dot.is-connected')).toBeVisible()
    const firstTerminalLine = () => page.locator('.terminal-surface:not([hidden]) .xterm-rows').evaluate((rows) =>
      [...rows.children].map((row) => row.textContent?.trim() ?? '').find(Boolean) ?? '',
    )
    await expect.poll(firstTerminalLine).toMatch(/\S/)
    expect(await firstTerminalLine()).not.toBe('%')
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    const activeTerminal = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await activeTerminal.click()
    await page.keyboard.type('echo first-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    await page.getByLabel('New terminal').click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await activeTerminal.click()
    await page.keyboard.type('echo second-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('second-terminal')

    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText('second-terminal')

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText(/first-terminal|second-terminal/)
    await expect(page.getByLabel(/Split terminal/)).toHaveCount(0)

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    const geometry = await page.evaluate(() => {
      const session = document.querySelector('.session-workspace')!.getBoundingClientRect()
      const conversation = document.querySelector('.conversation-column')!.getBoundingClientRect()
      const terminal = document.querySelector('.terminal-drawer')!.getBoundingClientRect()
      const inspector = document.querySelector('.inspector')!.getBoundingClientRect()
      return {
        terminalRight: terminal.right,
        conversationRight: conversation.right,
        sessionTop: session.top,
        sessionBottom: session.bottom,
        inspectorTop: inspector.top,
        inspectorBottom: inspector.bottom,
      }
    })
    expect(Math.abs(geometry.terminalRight - geometry.conversationRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorTop - geometry.sessionTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorBottom - geometry.sessionBottom)).toBeLessThanOrEqual(1)

    const drawer = page.locator('.terminal-drawer:not([hidden])')
    const before = await drawer.evaluate((node) => node.getBoundingClientRect().height)
    await drawer.getByLabel('Maximize terminal').click()
    await expect(drawer).toHaveClass(/is-maximized/)
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before)
    await drawer.getByLabel('Restore terminal').click()
    await drawer.getByLabel('Close terminal', { exact: true }).click()
  })

  test('attaches and removes active terminal selection context', async () => {
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    const input = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await input.click()
    await page.keyboard.type("printf 'terminal-selection-marker\\n'")
    await page.keyboard.press('Enter')
    const outputLine = page.locator('.terminal-surface:not([hidden]) .xterm-rows > div').filter({ hasText: 'terminal-selection-marker' }).last()
    await expect(outputLine).toBeVisible()
    await expect(page.locator('.composer-attachment--terminal')).toHaveCount(0)

    const selectOutput = async () => {
      const box = await outputLine.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(Math.min(box!.x + box!.width - 2, box!.x + 190), box!.y + box!.height / 2, { steps: 5 })
      await page.mouse.up()
      await expect(page.getByLabel(/Inspect selected text from/)).toBeVisible()
    }

    await selectOutput()
    const clearBox = await outputLine.boundingBox()
    expect(clearBox).not.toBeNull()
    await page.mouse.click(clearBox!.x + 2, clearBox!.y + clearBox!.height / 2)
    await expect(page.getByLabel(/Inspect selected text from/)).toHaveCount(0)
    await selectOutput()

    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Explain the terminal output')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(true)
    const prompt = JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8')) as { message: string }
    expect(prompt.message).toContain('Explain the terminal output\n\n===== BEGIN TERMINAL SELECTION CONTEXT =====')
    expect(prompt.message).toContain('--- Selected text ---')
    expect(prompt.message).toContain('terminal-selection-marker')
    expect(prompt.message).not.toContain('Terminal buffer')
  })

})
