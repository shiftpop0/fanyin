import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeAudio } from './api'

class FakeXMLHttpRequest {
  static latest: FakeXMLHttpRequest | null = null

  readonly upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
    onload: null as (() => void) | null,
  }

  responseType: XMLHttpRequestResponseType = ''
  responseText = ''
  status = 0
  timeout = 0
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onload: (() => void) | null = null

  constructor() {
    FakeXMLHttpRequest.latest = this
  }

  open() {}

  setRequestHeader() {}

  send() {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeXMLHttpRequest.latest = null
})

describe('transcription API client', () => {
  it('preserves a JSON business error instead of reading an unavailable JSON responseText', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
    const request = transcribeAudio({
      file: new File(['wav'], 'sample.wav', { type: 'audio/wav' }),
      diarize: false,
    })
    const xhr = FakeXMLHttpRequest.latest
    expect(xhr).not.toBeNull()
    expect(xhr?.responseType).toBe('text')
    expect(xhr?.timeout).toBe(12 * 60 * 1000)

    xhr!.status = 200
    xhr!.responseText = JSON.stringify({
      code: 500,
      language: '',
      data: [],
      file_name: 'sample.wav',
      message: '模型处理失败',
      uuid: 'request-id',
    })
    xhr!.onload?.()

    await expect(request).rejects.toMatchObject({
      name: 'ApiError',
      message: '模型处理失败',
      response: { code: 500, message: '模型处理失败' },
    })
  })
})
