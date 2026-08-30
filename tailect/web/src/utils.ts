import type { CaptionRow } from './types'

export const ACCEPTED_AUDIO =
  'audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wma,.amr,.sdp'

const ACCEPTED_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.wma',
  '.amr',
  '.sdp',
])

export interface FileLike {
  name: string
  size: number
  type?: string
}

export function validateAudioFile(file: FileLike, maxUploadMb: number): string | null {
  if (!file.name.trim()) return '文件名不能为空'
  if (file.size <= 0) return '音频文件为空'
  const limitBytes = Math.max(1, maxUploadMb) * 1024 * 1024
  if (file.size > limitBytes) return `文件不能超过 ${maxUploadMb} MB`
  const dotIndex = file.name.lastIndexOf('.')
  const extension = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : ''
  const audioMime = Boolean(file.type?.toLowerCase().startsWith('audio/'))
  if (!audioMime && !ACCEPTED_EXTENSIONS.has(extension)) {
    return '请选择常见音频格式文件'
  }
  return null
}

export function buildTranscriptionPath(
  language: string,
  diarize: boolean,
  maxChars: number,
): string {
  const params = new URLSearchParams({
    model: 'Tailect_V4.1',
    language,
    diarize: diarize ? '1' : '0',
    max_chars: String(maxChars),
  })
  return `/v1/audiototext?${params.toString()}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`
}

export function formatMilliseconds(milliseconds: number): string {
  const safe = Math.max(0, Number(milliseconds) || 0)
  const hours = Math.floor(safe / 3_600_000)
  const minutes = Math.floor((safe % 3_600_000) / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  const millis = Math.floor(safe % 1000)
  const prefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''
  return `${prefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

export function fullTranscript(rows: CaptionRow[]): string {
  return rows.map((row) => row.text.trim()).filter(Boolean).join('\n')
}
