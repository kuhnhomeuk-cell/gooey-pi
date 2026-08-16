import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachHermeticHooks, expect, fixtureRoot, page, test } from './fixtures/desktop'

test.describe('Prime Work schedules', () => {
  test.describe.configure({ mode: 'parallel' })
  attachHermeticHooks()

  test('creates a schedule and runs it now through the Scheduled page', async () => {
    await page.getByRole('button', { name: 'Scheduled', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Scheduled' })).toBeVisible()
    await page.getByRole('button', { name: 'Create schedule' }).click()
    const editor = page.getByRole('dialog', { name: 'Create schedule' })
    await expect(editor).toBeVisible()
    await editor.getByLabel('Title').fill('Hermetic run now')
    await editor.getByLabel('Prompt').fill('Scheduled hermetic prompt')
    await expect(editor.getByRole('radio', { name: /New session/ })).toBeChecked()
    await expect(editor.getByLabel('Authorized project')).toHaveValue(/.+/)
    await editor.getByText('Once', { exact: true }).click()
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
    await editor.locator('input[type="date"]').fill(date)
    await editor.getByRole('button', { name: 'Create schedule' }).click()
    await expect(editor).toHaveCount(0)
    const row = page.getByRole('button', { name: 'Open Hermetic run now' })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByRole('heading', { name: 'Hermetic run now' })).toBeVisible()
    await page.getByRole('button', { name: 'Run now' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Run queued.' })).toBeVisible()
    await expect.poll(async () => {
      const records = await page.evaluate(async () => window.prime.schedules.list('prime'))
      const created = records.find((item) => item.title === 'Hermetic run now')
      return created?.runs[0]?.status ?? ''
    }).toMatch(/queued|running|succeeded|failed/)
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-args.json')) ? JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8')).message : '').toBe('Scheduled hermetic prompt')
    await expect.poll(async () => {
      const records = await page.evaluate(async () => window.prime.schedules.list('prime'))
      return records.find((item) => item.title === 'Hermetic run now')?.runs[0]?.status ?? ''
    }).toBe('succeeded')
    await expect(page.locator('.schedule-run--succeeded')).toBeVisible()
  })

})
