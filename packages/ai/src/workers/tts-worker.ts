export interface TtsRequest {
  id: string
  text: string
  voice: string
  speed: number
}

export interface TtsResult {
  id: string
  estimatedDuration: number
  status: 'queued' | 'ready'
}

export function estimateTtsDuration(text: string, speed = 1): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latinWords = (text.match(/[A-Za-z0-9]+/g) ?? []).length
  const spokenUnits = cjk + latinWords
  return Math.max(0.6, spokenUnits / (4.2 * speed))
}
