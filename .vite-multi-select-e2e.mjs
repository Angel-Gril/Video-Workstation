import { chromium } from 'playwright'

const now = new Date().toISOString()
const clips = [0, 1, 2].map((index) => ({
  id: `e2e-clip-${index}`,
  trackId: 'track-video',
  mediaId: 'e2e-media',
  sourceStart: index * 2,
  timelineStart: index * 2,
  duration: 2,
  transform: {
    scale: 1,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    brightness: 1,
    contrast: 1,
    saturation: 1
  },
  effects: [],
  volume: 1,
  transitionIn: 'none',
  transitionOut: 'none'
}))

await fetch('http://127.0.0.1:7350/api/project', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    format: 'ai-video-workstation/1',
    project: {
      meta: {
        version: 1,
        name: 'E2E',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        width: 1920,
        height: 1080,
        frameRate: 30
      },
      media: [{
        id: 'e2e-media',
        kind: 'video',
        name: 'E2E Source',
        path: 'C:/Users/Administrator/Downloads/Video/TEST.mp4',
        duration: 12,
        width: 1920,
        height: 1080,
        frameRate: 30,
        audioChannels: 2,
        audioSampleRate: 44100,
        codec: 'h264'
      }],
  timeline: {
        duration: 0,
        tracks: [
          { kind: 'video', id: 'track-video', locked: false, muted: false, hidden: false, clips },
          { kind: 'audio', id: 'track-audio', locked: false, muted: false, hidden: false, clips: [] },
          { kind: 'caption', id: 'track-caption', locked: false, muted: false, hidden: false, clips: [] }
        ]
      }
    }
  })
})
await new Promise((resolve) => setTimeout(resolve, 1500))

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
await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length > 0)
try {
  await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 3, undefined, { timeout: 5000 })
} catch (error) {
  const state = await page.evaluate(() => ({
    clips: document.querySelectorAll('.timeline-clip').length,
    body: document.body.innerText.slice(0, 500)
  }))
  console.error(JSON.stringify(state, null, 2))
  throw error
}

const initialClips = await page.locator('[data-clip-id^="e2e-clip-"]').count()
if (initialClips < 3) throw new Error(`Expected at least 3 clips, got ${initialClips}`)

const zoomDown = page.locator('.zoom-controls button[aria-label="缩小"]')
for (let index = 0; index < 4; index += 1) await zoomDown.click()
const zoomText = await page.locator('.zoom-controls span').textContent()
if (zoomText?.trim() !== '12 px/s') {
  throw new Error(`Zoom did not reach 12 px/s, got ${zoomText?.trim()}`)
}

await page.waitForTimeout(500)

async function clickClipCenter(index, additive = false) {
  const target = page.locator(`[data-clip-id="e2e-clip-${index}"]`)
  await target.scrollIntoViewIfNeeded()
  await page.waitForTimeout(80)
  const point = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left + Math.min(10, rect.width / 2), y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(point.x, point.y)
  if (additive) {
    await page.keyboard.down('Control')
    await page.mouse.down()
    await page.mouse.up()
    await page.keyboard.up('Control')
  } else {
    await page.mouse.down()
    await page.mouse.up()
  }
}

await clickClipCenter(0)
await page.waitForFunction(() => document.querySelectorAll('[data-clip-id].multi-selected').length === 1, undefined, { timeout: 5000 })
await clickClipCenter(1, true)
await page.waitForFunction(() => document.querySelectorAll('[data-clip-id].multi-selected').length === 2, undefined, { timeout: 5000 })
await clickClipCenter(2, true)
try {
  await page.waitForFunction(() => document.querySelectorAll('.timeline-clip.multi-selected').length === 3, undefined, { timeout: 5000 })
} catch (error) {
  await page.screenshot({ path: 'multiselect-failure.png', fullPage: false })
  const state = await page.evaluate(() => ({
    selected: document.querySelectorAll('.timeline-clip.selected').length,
    multi: document.querySelectorAll('.timeline-clip.multi-selected').length,
    clips: [...document.querySelectorAll('.timeline-clip')].map((clip) => ({
      text: clip.textContent,
      left: clip.style.left,
      rect: clip.getBoundingClientRect().toJSON()
    }))
  }))
  console.error(JSON.stringify(state, null, 2))
  throw error
}

const readLefts = () => page.evaluate(() => [...document.querySelectorAll('.timeline-clip')]
  .map((element) => Number.parseFloat(element.style.left)))
const before = await readLefts()

const anchor = await page.locator('[data-clip-id="e2e-clip-0"]').evaluate((element) => {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + 32, y: rect.top + rect.height / 2 }
})
await page.mouse.move(anchor.x, anchor.y)
await page.mouse.down()
await page.mouse.move(anchor.x + 36, anchor.y, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(250)

const after = await readLefts()
const selectedDeltas = [0, 1, 2].map((index) => after[index] - before[index])
if (!selectedDeltas.every((delta) => delta >= 1.8)) {
  throw new Error(`Group drag did not move every selected clip: ${selectedDeltas.join(', ')}`)
}

await page.click('.timeline-toolbar button:text("拆分")')
await page.waitForTimeout(250)
const clipsAfterSplit = await page.locator('[data-clip-id]').count()
if (clipsAfterSplit !== initialClips + 3) {
  throw new Error(`Batch split expected ${initialClips + 3} clips, got ${clipsAfterSplit}`)
}

const marqueeTargets = await page.locator('[data-clip-id]').evaluateAll((elements) =>
  elements.slice(0, 2).map((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  })
)
if (marqueeTargets.length < 2) throw new Error(`Expected 2 marquee targets, got ${marqueeTargets.length}`)
const canvasLeft = await page.locator('.timeline-canvas').evaluate((element) => element.getBoundingClientRect().left)
const marqueeStart = {
  x: canvasLeft + 100,
  y: Math.min(...marqueeTargets.map((item) => item.top)) + (marqueeTargets[0].bottom - marqueeTargets[0].top) / 2
}
const marqueeEnd = {
  x: Math.max(...marqueeTargets.map((item) => item.right)) + 5,
  y: marqueeStart.y
}
await page.mouse.move(marqueeStart.x, marqueeStart.y)
await page.mouse.down()
await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(250)
const marqueeCount = await page.locator('[data-clip-id].multi-selected').count()
if (marqueeCount < 2) throw new Error(`Marquee selected only ${marqueeCount} clips`)

await page.click('.timeline-toolbar button:text("删除")')
await page.waitForTimeout(250)
const clipsAfterDelete = await page.locator('.timeline-clip').count()
if (clipsAfterDelete !== clipsAfterSplit - marqueeCount) {
  throw new Error(`Batch delete left ${clipsAfterDelete} clips, expected ${clipsAfterSplit - marqueeCount}`)
}

await page.click('.topbar-actions button:text("撤销")')
await page.waitForTimeout(250)
const restored = await page.locator('[data-clip-id]').count()
if (restored !== clipsAfterSplit) {
  throw new Error(`Undo restored ${restored} clips, expected ${clipsAfterSplit}`)
}

await clickClipCenter(0)
await page.waitForFunction(() => document.querySelectorAll('[data-clip-id].multi-selected').length === 1, undefined, { timeout: 5000 })
await clickClipCenter(1, true)
await page.waitForFunction(() => document.querySelectorAll('[data-clip-id].multi-selected').length === 2, undefined, { timeout: 5000 })
console.log('selection', await page.evaluate(() => ({
  selected: [...document.querySelectorAll('[data-clip-id].selected')].map((item) => item.getAttribute('data-clip-id')),
  multi: [...document.querySelectorAll('[data-clip-id].multi-selected')].map((item) => item.getAttribute('data-clip-id'))
})))
await page.selectOption('label.field:has(span:text("入点转场")) select', 'fade')
await page.selectOption('label.field:has(span:text("转场时长")) select', '0.8')
await page.waitForTimeout(1400)
const transitionCount = await page.evaluate(() => fetch('/api/project')
  .then((response) => response.json())
  .then((data) => data.project.timeline.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => ['e2e-clip-0', 'e2e-clip-1'].includes(clip.id))
    .filter((clip) => clip.transitionIn === 'fade' && Math.abs((clip.transitionDuration ?? 0.5) - 0.8) < .001)
    .length))
if (transitionCount !== 2) {
  throw new Error(`Batch transition only updated ${transitionCount} of 2 clips`)
}

const snappingOn = await page.locator('.timeline-toolbar button:text("吸附")')
  .evaluate((element) => element.classList.contains('active'))
if (!snappingOn) throw new Error('Snapping toggle did not initialize active')

await page.screenshot({ path: 'workstation-multiselect.png', fullPage: false })
console.log(JSON.stringify({
  initialClips,
  clipsAfterSplit,
  marqueeCount,
  clipsAfterDelete,
  restored,
  selectedDeltas,
  transitionCount,
  snappingOn
}))
await browser.close()
