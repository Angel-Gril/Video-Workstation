import { chromium } from 'playwright'
import { unlinkSync } from 'node:fs'

try { unlinkSync('.aiwork/current.aiwork.json') } catch {}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
page.on('pageerror', (error) => {
  console.error(`[pageerror] ${error.stack ?? error.message}`)
  process.exitCode = 1
})
page.on('console', (message) => {
  if (message.type() === 'error') console.error(`[console:error] ${message.text()}`)
})

await page.goto('http://127.0.0.1:5173')
await page.waitForFunction(() => document.querySelector('.service')?.textContent?.includes('在线'))
await page.fill('input[placeholder="D:/media/sample.mp4"]', 'C:/Users/Administrator/Downloads/Video/TEST.mp4')
await page.click('.left-panel .section-head button:text("导入")')
await page.waitForSelector('.asset-item', { timeout: 20000 })
await page.waitForFunction(() => document.querySelector('.statusbar .message')?.textContent?.includes('已导入'))

for (let index = 0; index < 3; index += 1) {
  await page.click('.asset-item button:text("时间线")')
  await page.waitForTimeout(350)
}

const initialClips = await page.locator('.timeline-clip').count()
if (initialClips < 3) throw new Error(`Expected at least 3 clips, got ${initialClips}`)
let clips = initialClips

const first = page.locator('.timeline-clip').nth(0)
const second = page.locator('.timeline-clip').nth(1)
const third = page.locator('.timeline-clip').nth(2)
const firstBox = await first.boundingBox()
const secondBox = await second.boundingBox()
const thirdBox = await third.boundingBox()
if (!firstBox || !secondBox || !thirdBox) throw new Error('Timeline clips are not visible for selection')
await page.mouse.click(firstBox.x + 20, firstBox.y + firstBox.height / 2)
await page.keyboard.down('Control')
await page.mouse.click(secondBox.x + 20, secondBox.y + secondBox.height / 2)
await page.mouse.click(thirdBox.x + 20, thirdBox.y + thirdBox.height / 2)
await page.keyboard.up('Control')
console.log(JSON.stringify({
  initialClips,
  boxes: [firstBox, secondBox, thirdBox],
  multiSelected: await page.locator('.timeline-clip.multi-selected').count()
 }))
await page.waitForFunction(() => document.querySelectorAll('.timeline-clip.multi-selected').length === 3)

const before = []
for (let index = 0; index < initialClips; index += 1) {
  before.push(await page.locator('.timeline-clip').nth(index).evaluate(
    (element) => Number.parseFloat(element.style.left)
  ))
}

const anchor = await first.boundingBox()
if (!anchor) throw new Error('Anchor clip is not visible')
await page.mouse.move(anchor.x + 35, anchor.y + anchor.height / 2)
await page.mouse.down()
await page.mouse.move(anchor.x + 71, anchor.y + anchor.height / 2, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(350)

const dragged = []
for (let index = 0; index < initialClips; index += 1) {
  dragged.push(await page.locator('.timeline-clip').nth(index).evaluate(
    (element) => Number.parseFloat(element.style.left)
  ))
}
const deltas = dragged.map((value, index) => value - before[index])
const selectedDeltas = [0, 1, 2].map((index) => deltas[index % initialClips])
if (!selectedDeltas.every((delta) => delta > 20)) {
  throw new Error(`Group drag did not move every selected clip: ${selectedDeltas.join(', ')}`)
}

await page.click('.timeline-toolbar button:text("拆分")')
await page.waitForTimeout(350)
clips = await page.locator('.timeline-clip').count()
if (clips !== initialClips + 3) throw new Error(`Batch split expected ${initialClips + 3} clips, got ${clips}`)

await page.mouse.move(300, 250)
await page.mouse.down()
await page.mouse.move(1100, 450, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(300)
const marqueeCount = await page.locator('.timeline-clip.multi-selected').count()
if (marqueeCount < 2) throw new Error(`Marquee selected only ${marqueeCount} clips`)

await page.click('.timeline-toolbar button:text("删除")')
await page.waitForTimeout(350)
clips = await page.locator('.timeline-clip').count()
if (clips !== initialClips - 3) throw new Error(`Batch delete left ${clips} clips`)

await page.click('.topbar-actions button:text("撤销")')
await page.waitForTimeout(350)
const restored = await page.locator('.timeline-clip').count()
if (restored !== initialClips) throw new Error(`Undo restored ${restored} clips, expected ${initialClips}`)

const snappingOn = await page.locator('.timeline-toolbar button:text("吸附")').evaluate(
  (element) => element.classList.contains('active')
)
if (!snappingOn) throw new Error('Snapping toggle did not initialize active')

await page.screenshot({ path: 'workstation-multiselect.png', fullPage: false })
console.log(JSON.stringify({
  before,
  dragged,
  selectedDeltas,
  initialClips,
  clipsAfterSplit: initialClips + 3,
  marqueeCount,
  restored,
  snappingOn
 }))
await browser.close()
