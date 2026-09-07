import { describe, expect, it } from 'vitest'
import { createNarrativePlan, createSegmentPlan } from './planner'

describe('narrative planner', () => {
  it('creates executable clips within the target duration', () => {
    const plan = createNarrativePlan({
      goal: 'summary',
      targetSeconds: 4,
      transcript: [],
      scenes: [
        { mediaId: 'media-1', start: 0, end: 3, score: 0.8 },
        { mediaId: 'media-1', start: 5, end: 8, score: 0.6 }
      ],
      instruction: '快节奏'
    })

    expect(plan.segments).toHaveLength(2)
    expect(plan.commands.filter((item) => item.kind === 'clip.add')).toHaveLength(2)
    expect(plan.segments.at(-1)!.source.end - plan.segments.at(-1)!.source.start).toBe(1)
  })

  it('maps speech into caption clips', () => {
    const plan = createNarrativePlan({
      goal: 'tutorial',
      targetSeconds: 3,
      transcript: [{ id: 's1', mediaId: 'media-1', start: 0.5, end: 2.5, text: ' 第一步，导入素材。 ' }],
      scenes: [{ mediaId: 'media-1', start: 0, end: 3, score: 0.7 }]
    })

    const captions = plan.commands.filter((item) => item.payload.clip && (item.payload.clip as { trackId?: string }).trackId === 'track-caption')
    expect(captions).toHaveLength(1)
  })

  it('explains plan factors and changes segment order by strategy', () => {
    const input = {
      goal: 'summary' as const,
      targetSeconds: 4,
      transcript: [
        { id: 'speech-1', mediaId: 'media-1', start: 0, end: 4, text: '保留讲解' },
        { id: 'speech-2', mediaId: 'media-1', start: 8, end: 9, text: '普通片段' }
      ],
      scenes: [
        { mediaId: 'media-1', start: 0, end: 4, score: 0.2 },
        { mediaId: 'media-1', start: 8, end: 12, score: 0.95 }
      ],
      instruction: '保留讲解'
    }

    const speechPlan = createNarrativePlan(input, { strategyId: 'speech' })
    const visualPlan = createNarrativePlan(input, { strategyId: 'visual' })
    expect(speechPlan.segments[0]?.source.start).toBe(0)
    expect(visualPlan.segments[0]?.source.start).toBe(8)
    expect(speechPlan.segments[0]?.factors.some((factor) => factor.id === 'intent' && factor.value > 0)).toBe(true)
    expect(speechPlan.segments[0]?.reasons.some((reason) => reason.includes('保留讲解'))).toBe(true)
  })

  it('creates executable commands from accepted segments only', () => {
    const input = {
      goal: 'summary' as const,
      targetSeconds: 8,
      transcript: [],
      scenes: [
        { mediaId: 'media-1', start: 0, end: 3, score: 0.9 },
        { mediaId: 'media-1', start: 5, end: 8, score: 0.7 }
      ]
    }
    const initial = createNarrativePlan(input)
    expect(initial.segments).toHaveLength(2)

    const revised = createSegmentPlan(initial, [initial.segments[1]!.id], 'balanced')
    expect(revised.selectedIds).toEqual([initial.segments[1]!.id])
    expect(revised.segments[0]?.selected).toBe(false)
    expect(revised.commands.filter((command) => command.kind === 'clip.add')).toHaveLength(1)
    expect(revised.commands[0]?.payload.clip).toMatchObject({
      mediaId: 'media-1',
      sourceStart: 5,
      timelineStart: 0
    })
  })
})
