import type { HealthResponse, TranscriptionOptions, TranscriptionResponse } from './types'
import { buildTranscriptionPath } from './utils'

const configuredBase = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')
const REQUEST_TIMEOUT_MS = 12 * 60 * 1000

function endpoint(path: string): string {
  return `${configuredBase}${path}`
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly response?: TranscriptionResponse,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(endpoint('/health'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`健康检查失败（HTTP ${response.status}）`)
  const body = (await response.json()) as HealthResponse
  if (body.status !== 'ok') throw new Error('服务健康状态异常')
  return body
}

export function transcribeAudio(options: TranscriptionOptions): Promise<TranscriptionResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(
      'POST',
      endpoint(buildTranscriptionPath(options.diarize)),
    )
    // Keep the raw body available for both success and error responses. Browsers
    // throw InvalidStateError when responseText is read with responseType="json".
    xhr.responseType = 'text'
    xhr.timeout = REQUEST_TIMEOUT_MS
    xhr.setRequestHeader('Accept', 'application/json')
    if (options.apiKey?.trim()) xhr.setRequestHeader('X-API-Key', options.apiKey.trim())

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : options.file.size
      const percent = total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0
      options.onUploadProgress?.(event.loaded, total, percent)
    }
    xhr.upload.onload = () => options.onProcessing?.()
    xhr.onerror = () => reject(new ApiError('网络连接失败，请检查 8885 服务'))
    xhr.onabort = () => reject(new ApiError('请求已取消'))
    xhr.ontimeout = () => reject(new ApiError('请求超时'))
    xhr.onload = () => {
      let body: TranscriptionResponse | null = null
      if (xhr.responseText) {
        try {
          body = JSON.parse(xhr.responseText) as TranscriptionResponse
        } catch {
          reject(new ApiError(`服务返回了无法解析的响应（HTTP ${xhr.status}）`))
          return
        }
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(`请求失败（HTTP ${xhr.status}）`, body ?? undefined))
        return
      }
      if (!body || body.code !== 200) {
        reject(new ApiError(body?.message || '音频转写失败', body ?? undefined))
        return
      }
      resolve(body)
    }

    const form = new FormData()
    form.append('file', options.file, options.file.name)
    xhr.send(form)
  })
}
