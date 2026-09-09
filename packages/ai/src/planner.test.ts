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

  it('uses visual signals in the explanation', () => {
    const plan = createNarrativePlan({
      goal: 'highlights',
      targetSeconds: 4,
      transcript: [],
      scenes: [{ mediaId: 'media-1', start: 0, end: 4, score: 0.6 }],
      visualSignals: [{
        mediaId: 'media-1',
        start: 0,
        end: 4,
        brightness: 0.72,
        saturation: 0.58,
        motion: 0.81,
        objects: []
      }]
    }, { strategyId: 'visual' })

    const factor = plan.segments[0]?.factors.find((item) => item.id === 'visual')
    expect(factor?.value).toBeCloseTo(0.81)
    expect(factor?.detail).toContain('0.81')
    expect(factor?.detail).toContain('0.72')
    expect(plan.segments[0]?.visual).toEqual({
      motion: 0.81,
      brightness: 0.72,
      saturation: 0.58,
      detail: 0.81,
      speechiness: 0,
      musicLikelihood: 0.74,
      labels: []
    })
    expect(plan.analysis.visualSignalCount).toBe(1)
  })

  it('ranks low-speech ambient scenes for mixed cuts', () => {
    const input = {
      goal: 'highlights' as const,
      targetSeconds: 4,
      transcript: [
        { id: 'speech-1', mediaId: 'media-1', start: 0, end: 4, text: '密集讲解' },
        { id: 'speech-2', mediaId: 'media-1', start: 5, end: 6.8, text: '短语音' }
      ],
      scenes: [
        { mediaId: 'media-1', start: 0, end: 4, score: 0.62 },
        { mediaId: 'media-1', start: 5, end: 9, score: 0.70 }
      ],
      visualSignals: [
        {
          mediaId: 'media-1',
          start: 0,
          end: 4,
          brightness: .6,
          saturation: .5,
          motion: .2,
          objects: [],
          labels: ['自然风光']
        },
        {
          mediaId: 'media-1',
          start: 5,
          end: 9,
          brightness: .6,
          saturation: .5,
          motion: .75,
          objects: [],
          labels: ['自然风光']
        }
      ]
    }

    const mixedPlan = createNarrativePlan(input, { strategyId: 'mixed' })
    const speechPlan = createNarrativePlan(input, { strategyId: 'speech' })
    expect(mixedPlan.segments[0]?.source.start).toBe(5)
    expect(mixedPlan.segments[0]?.reasons.join(' ')).toContain('疑似音乐/环境段')
    expect(speechPlan.segments[0]?.source.start).toBe(0)
  })

  it('normalizes custom multi-objective weights and explains keyword evidence', () => {
    const plan = createNarrativePlan({
      goal: 'highlights',
      targetSeconds: 4,
      transcript: [{ id: 's1', mediaId: 'media-1', start: 0, end: 4, text: '这里是重点画面' }],
      scenes: [{ mediaId: 'media-1', start: 0, end: 4, score: 0.8 }],
      instruction: '重点'
    }, {
      candidateLimit: 12,
      weights: { scene: 2, keyword: 3 }
    })

    const summary = plan.weightSummary.normalized
    expect(Object.values(summary).reduce((total, value) => total + value, 0)).toBeCloseTo(1)
    expect(summary.keyword).toBeGreaterThan(summary.scene)
    expect(plan.candidateCount).toBeGreaterThan(0)
    expect(plan.segments[0]?.factors.some((factor) =>
      factor.id === 'keyword' && factor.detail.includes('重点')
    )).toBe(true)
  })

  it('limits ranking candidates while keeping chronological output', () => {
    const scenes = Array.from({ length: 80 }, (_, index) => ({
      mediaId: `media-${index % 3}`,
      start: index * 5,
      end: index * 5 + 4,
      score: (index % 10) / 10
    }))
    const plan = createNarrativePlan({
      goal: 'summary',
      targetSeconds: 4,
      transcript: [],
      scenes
    }, { candidateLimit: 8 })

    expect(plan.candidateCount).toBe(80)
    expect(plan.segments.length).toBeLessThanOrEqual(8)
    expect(plan.segments.every((segment, index) =>
      index === 0 || segment.source.start >= plan.segments[index - 1]!.source.end
    )).toBe(true)
  })
})
