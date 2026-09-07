import type { CaptionDraft, SpeechSegment } from '../types'

export function transcriptToCaptions(segments: SpeechSegment[]): CaptionDraft[] {
  return segments.map((segment) => ({
    id: `caption-${segment.id}`,
    mediaId: segment.mediaId,
    start: segment.start,
    end: segment.end,
    text: segment.text.trim()
  }))
}
