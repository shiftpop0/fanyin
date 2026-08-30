import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  ConfigProvider,
  Input,
  InputNumber,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
  theme,
  type TableColumnsType,
  type UploadFile,
  type UploadProps,
} from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  AudioOutlined,
  CopyOutlined,
  DeleteOutlined,
  InboxOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { ApiError, fetchHealth, transcribeAudio } from './api'
import type { CaptionRow, HealthResponse, TranscriptionResponse } from './types'
import {
  ACCEPTED_AUDIO,
  formatBytes,
  formatMilliseconds,
  fullTranscript,
  validateAudioFile,
} from './utils'
import './styles.css'

type Phase = 'idle' | 'uploading' | 'processing' | 'success' | 'error'

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: '自动（默认中文）' },
  { value: 'zh', label: '中文' },
  { value: 'yue', label: '粤语' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
]

function TranscriptionPage() {
  const { message } = AntApp.useApp()
  const { token } = theme.useToken()
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState('')
  const [healthLoading, setHealthLoading] = useState(false)
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [language, setLanguage] = useState('auto')
  const [diarize, setDiarize] = useState(false)
  const [maxChars, setMaxChars] = useState(40)
  const [apiKey, setApiKey] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [uploadPercent, setUploadPercent] = useState(0)
  const [uploadedBytes, setUploadedBytes] = useState(0)
  const [uploadTotal, setUploadTotal] = useState(0)
  const [result, setResult] = useState<TranscriptionResponse | null>(null)
  const [errorText, setErrorText] = useState('')

  const maxUploadMb = health?.max_upload_mb ?? 512
  const busy = phase === 'uploading' || phase === 'processing'
  const serviceReady = health?.status === 'ok' && health.service_ready !== false

  const loadHealth = useCallback(async () => {
    setHealthLoading(true)
    setHealthError('')
    try {
      setHealth(await fetchHealth())
    } catch (error) {
      setHealth(null)
      setHealthError(error instanceof Error ? error.message : '无法连接服务')
    } finally {
      setHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHealth(), 0)
    return () => window.clearTimeout(timer)
  }, [loadHealth])

  const clearResult = () => {
    setResult(null)
    setErrorText('')
    setPhase('idle')
    setUploadPercent(0)
    setUploadedBytes(0)
    setUploadTotal(0)
  }

  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    const validationError = validateAudioFile(file, maxUploadMb)
    if (validationError) {
      void message.error(validationError)
      return Upload.LIST_IGNORE
    }
    clearResult()
    setAudioFile(file)
    setFileList([
      {
        uid: file.uid,
        name: file.name,
        size: file.size,
        type: file.type,
        status: 'done',
        originFileObj: file,
      },
    ])
    return false
  }

  const removeFile = () => {
    if (busy) return false
    setAudioFile(null)
    setFileList([])
    clearResult()
    return true
  }

  const startTranscription = async () => {
    if (!audioFile) {
      void message.warning('请先选择音频文件')
      return
    }
    const validationError = validateAudioFile(audioFile, maxUploadMb)
    if (validationError) {
      void message.error(validationError)
      return
    }
    if (health?.api_key_required && !apiKey.trim()) {
      void message.warning('请输入 API Key')
      return
    }

    setResult(null)
    setErrorText('')
    setUploadPercent(0)
    setUploadedBytes(0)
    setUploadTotal(audioFile.size)
    setPhase('uploading')
    try {
      const response = await transcribeAudio({
        file: audioFile,
        language,
        diarize,
        maxChars,
        apiKey,
        onUploadProgress: (loaded, total, percent) => {
          setUploadedBytes(loaded)
          setUploadTotal(total)
          setUploadPercent(percent)
        },
        onProcessing: () => {
          setUploadPercent(100)
          setUploadedBytes(audioFile.size)
          setPhase('processing')
        },
      })
      setResult(response)
      setPhase('success')
      setAudioFile(null)
      setFileList([])
      void message.success('音频转写完成')
    } catch (error) {
      const text = error instanceof ApiError || error instanceof Error ? error.message : '音频转写失败'
      setErrorText(text)
      setPhase('error')
    }
  }

  const copyTranscript = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(fullTranscript(result.data))
      void message.success('全文已复制')
    } catch {
      void message.error('复制失败，请手动选择文字')
    }
  }

  const columns: TableColumnsType<CaptionRow> = useMemo(
    () => [
      { title: '说话人', dataIndex: 'lid', width: 90, render: (value: string) => `#${value}` },
      {
        title: '开始',
        dataIndex: 'begin',
        width: 120,
        render: (value: number) => formatMilliseconds(value),
      },
      {
        title: '结束',
        dataIndex: 'end',
        width: 120,
        render: (value: number) => formatMilliseconds(value),
      },
      { title: '转写文字', dataIndex: 'text' },
    ],
    [],
  )

  const phaseLabel = {
    idle: '等待音频',
    uploading: '上传中',
    processing: '模型处理中',
    success: '已完成',
    error: '处理失败',
  }[phase]

  const phaseColor = {
    idle: 'default',
    uploading: 'processing',
    processing: 'processing',
    success: 'success',
    error: 'error',
  }[phase]

  return (
    <div
      className="page-shell"
      style={{ background: token.colorBgLayout, color: token.colorText }}
    >
      <main className="page-content">
        <header className="page-header">
          <Space align="center" size="middle">
            <div className="brand-icon" style={{ background: token.colorPrimaryBg }}>
              <AudioOutlined style={{ color: token.colorPrimary }} />
            </div>
            <div>
              <Typography.Title level={2} className="page-title">
                Tailect V4.1 音频转文字
              </Typography.Title>
              <Typography.Text type="secondary">内网离线语音识别工作台</Typography.Text>
            </div>
          </Space>
          <Tag color={phaseColor}>{phaseLabel}</Tag>
        </header>

        <Card
          title="服务状态"
          extra={
            <Button
              icon={<ReloadOutlined />}
              loading={healthLoading}
              onClick={() => void loadHealth()}
            >
              刷新
            </Button>
          }
        >
          {healthError ? (
            <Alert type="error" showIcon title="无法连接 8885 服务" description={healthError} />
          ) : health ? (
            <Space size="middle" wrap>
              <Tag color={serviceReady ? 'success' : 'error'}>
                {serviceReady ? '服务就绪' : '服务未就绪'}
              </Tag>
              <Typography.Text>模型：{health.model || 'Tailect_V4.1'}</Typography.Text>
              <Typography.Text>CUDA：{health.cuda ? '可用' : '不可用'}</Typography.Text>
              <Typography.Text>
                时间戳：{health.forced_aligner_ready ? '可用' : '不可用'}
              </Typography.Text>
              <Typography.Text>
                说话人：{health.diarization_ready ? '可用' : '不可用'}
              </Typography.Text>
              <Typography.Text>上传上限：{maxUploadMb} MB</Typography.Text>
            </Space>
          ) : (
            <Spin size="small" description="正在检查服务" />
          )}
        </Card>

        <div className="workspace-grid">
          <Card title="音频与转写选项">
            <Space orientation="vertical" size="large" className="full-width">
              <Upload.Dragger
                accept={ACCEPTED_AUDIO}
                beforeUpload={beforeUpload}
                fileList={fileList}
                maxCount={1}
                multiple={false}
                disabled={busy}
                onRemove={removeFile}
                onChange={() => undefined}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text">拖拽音频到这里，或点击选择文件</p>
                <p className="ant-upload-hint">单文件，最大 {maxUploadMb} MB；文件不会在页面中持久保存</p>
              </Upload.Dragger>

              <div className="option-grid">
                <label className="field-block">
                  <Typography.Text strong>识别语言</Typography.Text>
                  <Select
                    value={language}
                    options={LANGUAGE_OPTIONS}
                    disabled={busy}
                    onChange={setLanguage}
                  />
                </label>
                <label className="field-block">
                  <Typography.Text strong>每行最大字符数</Typography.Text>
                  <InputNumber
                    value={maxChars}
                    min={1}
                    max={500}
                    precision={0}
                    disabled={busy}
                    onChange={(value) => setMaxChars(typeof value === 'number' ? value : 40)}
                  />
                </label>
                <label className="switch-field">
                  <Typography.Text strong>区分说话人</Typography.Text>
                  <Switch
                    checked={diarize}
                    disabled={busy || health?.diarization_ready === false}
                    onChange={setDiarize}
                  />
                </label>
              </div>

              {health?.api_key_required && (
                <label className="field-block">
                  <Typography.Text strong>API Key</Typography.Text>
                  <Input.Password
                    value={apiKey}
                    autoComplete="off"
                    disabled={busy}
                    placeholder="仅保存在当前页面内存中"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
              )}

              <Button
                type="primary"
                size="large"
                block
                loading={busy}
                disabled={!audioFile || !serviceReady}
                onClick={() => void startTranscription()}
              >
                开始转写
              </Button>
            </Space>
          </Card>

          <Card title="处理状态">
            <div className="status-panel">
              {phase === 'idle' && (
                <Typography.Text type="secondary">选择音频并点击“开始转写”</Typography.Text>
              )}
              {phase === 'uploading' && (
                <Space orientation="vertical" size="middle" className="full-width">
                  <Typography.Text strong>正在上传音频</Typography.Text>
                  <Progress percent={uploadPercent} status="active" />
                  <Typography.Text type="secondary">
                    {formatBytes(uploadedBytes)} / {formatBytes(uploadTotal)}
                  </Typography.Text>
                </Space>
              )}
              {phase === 'processing' && (
                <Spin
                  size="large"
                  percent="auto"
                  description="音频已上传，Tailect 模型正在处理"
                />
              )}
              {phase === 'success' && result && (
                <Space orientation="vertical" size="small">
                  <Typography.Text strong>转写完成</Typography.Text>
                  <Typography.Text type="secondary">
                    {result.file_name} · {result.data.length} 个分段
                  </Typography.Text>
                </Space>
              )}
              {phase === 'error' && (
                <Alert type="error" showIcon title="转写失败" description={errorText} />
              )}
            </div>
          </Card>
        </div>

        {result && (
          <Card
            title="转写结果"
            extra={
              <Space wrap>
                <Button icon={<CopyOutlined />} onClick={() => void copyTranscript()}>
                  复制全文
                </Button>
                <Button danger icon={<DeleteOutlined />} onClick={clearResult}>
                  清空结果
                </Button>
              </Space>
            }
          >
            <div className="result-meta">
              <Typography.Text>语言：{result.language || '未知'}</Typography.Text>
              <Typography.Text>文件：{result.file_name}</Typography.Text>
              <Typography.Text copyable={{ text: result.uuid }}>任务：{result.uuid}</Typography.Text>
            </div>
            <Table<CaptionRow>
              rowKey={(row) => `${row.lid}-${row.begin}-${row.end}-${row.text}`}
              columns={columns}
              dataSource={result.data}
              pagination={false}
              size="middle"
              scroll={{ x: 720 }}
            />
          </Card>
        )}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <TranscriptionPage />
      </AntApp>
    </ConfigProvider>
  )
}
