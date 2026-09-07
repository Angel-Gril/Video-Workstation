import type { Keyframe, KeyframeTrack, TimelineClip } from './types'
import { sampleEasing } from './keyframes'

export function sampleKeyframeTrack(track: KeyframeTrack, time: number): number | null {
  const points = [...track.keyframes].sort((a, b) => a.time - b.time)
  if (points.length === 0) return null
  const first = points[0]!
  const last = points[points.length - 1]!
  if (time <= first.time) return first.value
  if (time >= last.time) return last.value

  const nextIndex = points.findIndex((point) => point.time > time)
  const next = points[nextIndex]!
  const previous = points[nextIndex - 1]!
  const progress = (time - previous.time) / (next.time - previous.time)
  const eased = sampleEasing(progress, next.easing)
  return previous.value + (next.value - previous.value) * eased
}

export function setKeyframe(
  track: KeyframeTrack,
  keyframe: Keyframe
): KeyframeTrack {
  const tolerance = 1 / 1000
  const keyframes = track.keyframes.filter(
    (point) => Math.abs(point.time - keyframe.time) > tolerance
  )
  keyframes.push(keyframe)
  keyframes.sort((a, b) => a.time - b.time)
  return { ...track, keyframes }
}

export function shiftKeyframeTrack(track: KeyframeTrack, delta: number): KeyframeTrack {
  return {
    ...track,
    keyframes: track.keyframes
      .map((point) => ({ ...point, time: point.time + delta }))
      .filter((point) => point.time >= 0)
  }
}

export function splitKeyframeTracks(
  clips: TimelineClip[],
  first: TimelineClip,
  second: TimelineClip
): TimelineClip[] {
  return clips.map((clip) => {
    if (clip.id === first.id) return first
    if (clip.id === second.id) return second
    return clip
  })
}
