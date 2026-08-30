import { describe, expect, it } from 'vitest'
import {
  buildTranscriptionPath,
  formatBytes,
  formatMilliseconds,
  fullTranscript,
  validateAudioFile,
} from './utils'

describe('audio file validation', () => {
  it('accepts common audio and rejects empty or oversized files', () => {
    expect(validateAudioFile({ name: 'sample.wav', size: 1024, type: 'audio/wav' }, 1)).toBeNull()
    expect(validateAudioFile({ name: 'sample.wav', size: 0, type: 'audio/wav' }, 1)).toBe('音频文件为空')
    expect(validateAudioFile({ name: 'sample.wav', size: 2 * 1024 * 1024 }, 1)).toBe(
      '文件不能超过 1 MB',
    )
    expect(validateAudioFile({ name: 'sample.txt', size: 1024, type: 'text/plain' }, 1)).toBe(
      '请选择常见音频格式文件',
    )
  })
})

describe('request and display helpers', () => {
  it('builds the existing 8885 API contract', () => {
    expect(buildTranscriptionPath(true)).toBe(
      '/v1/audiototext?model=Tailect_V4.1&diarize=1',
    )
  })

  it('formats sizes, timestamps and full text', () => {
    expect(formatBytes(1536)).toBe('1.50 KB')
    expect(formatMilliseconds(62_345)).toBe('01:02.345')
    expect(
      fullTranscript([
        { lid: '1', begin: 0, end: 100, text: '第一句。' },
        { lid: '1', begin: 100, end: 200, text: ' 第二句。 ' },
      ]),
    ).toBe('第一句。\n第二句。')
  })
})
