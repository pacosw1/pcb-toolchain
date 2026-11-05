import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
const APP = join(__dirname, '..')

test('real BASE-PWR geometry renders in bounded batches and stops rendering at rest', async () => {
  const root = process.env.PCBSTUDIO_3D_BENCHMARK
  test.skip(!root, 'Set PCBSTUDIO_3D_BENCHMARK to a real iot-lab project for the GPU benchmark')
  test.setTimeout(180_000)
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: root! } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
    await win.getByRole('button', { name: 'Choose board' }).click()
    await win.getByRole('dialog', { name: 'Boards' }).getByRole('searchbox').fill('BASE-PWR')
    await win.getByRole('option', { name: /BASE-PWR/ }).first().click()
    await win.getByRole('button', { name: '3D', exact: true }).click()
    const canvas = win.getByRole('img', { name: '3D board view' })
    await expect(canvas).toHaveAttribute('data-meshes', /\d+/, { timeout: 120_000 })
    await expect(win.getByLabel('3D model info')).toContainText('MB')
    await win.screenshot({ path: join(APP, 'test-results/3d-lighting.png') })
    await canvas.evaluate(el => { (el as HTMLElement).style.pointerEvents = 'none' })
    await win.waitForTimeout(1000)
    const idleFrames = Number(await canvas.getAttribute('data-frames'))
    await win.waitForTimeout(750)
    expect(Number(await canvas.getAttribute('data-frames')) - idleFrames).toBeLessThanOrEqual(1)
    await canvas.evaluate(el => { (el as HTMLElement).style.pointerEvents = '' })
    const baseline = { drawCalls: Number(await canvas.getAttribute('data-draw-calls')), triangles: Number(await canvas.getAttribute('data-triangles')), meshes: Number(await canvas.getAttribute('data-meshes')) }
    expect(baseline.drawCalls).toBeLessThan(6000)
    expect(baseline.triangles).toBeGreaterThan(100_000)
    // Controlled frame pacing over a real orbit, with no synthetic scene substitutions.
    await win.evaluate(() => {
      const values: number[] = []; let last = performance.now()
      const sample = (now: number): void => { values.push(now - last); last = now; if (values.length < 120) requestAnimationFrame(sample) }
      ;(window as unknown as { frameSamples: number[] }).frameSamples = values
      requestAnimationFrame(sample)
    })
    const box = (await canvas.boundingBox())!
    await win.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5)
    await win.mouse.down()
    await win.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 90 })
    await win.mouse.up()
    await win.waitForTimeout(1500)
    const samples = await win.evaluate(() => (window as unknown as { frameSamples: number[] }).frameSamples)
    const sorted = samples.slice(3).sort((a, b) => a - b)
    const evidence = { ...baseline, samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] }
    writeFileSync(join(APP, 'test-results/3d-performance.json'), JSON.stringify(evidence, null, 2))
    await win.getByRole('button', { name: 'Iso', exact: true }).click()
    await win.waitForTimeout(300)
    await win.screenshot({ path: join(APP, 'test-results/3d-performance.png') })
  } finally { await app.close() }
})
