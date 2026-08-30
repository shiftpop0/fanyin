export interface HealthResponse {
  status: string
  model?: string
  service_ready?: boolean
  cuda?: boolean
  diarization_ready?: boolean
  forced_aligner_ready?: boolean
  api_key_required?: boolean
  max_upload_mb?: number
  inference_queue?: {
    active?: number
    waiting?: number
    completed?: number
  }
}

export interface CaptionRow {
  lid: string
  text: string
  begin: number
  end: number
}

export interface TranscriptionResponse {
  code: number
  language: string
  data: CaptionRow[]
  file_name: string
  message: string
  uuid: string
}

export interface TranscriptionOptions {
  file: File
  diarize: boolean
  apiKey?: string
  onUploadProgress?: (loaded: number, total: number, percent: number) => void
  onProcessing?: () => void
}
