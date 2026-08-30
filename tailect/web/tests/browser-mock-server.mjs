import http from 'node:http'

const health = {
  status: 'ok',
  model: 'Tailect_V4.1',
  service_ready: true,
  cuda: true,
  diarization_ready: true,
  forced_aligner_ready: true,
  api_key_required: false,
  max_upload_mb: 512,
}

const transcription = {
  code: 200,
  language: 'zh',
  data: [
    { lid: '1', text: '这是第一段测试文字。', begin: 120, end: 1380 },
    { lid: '2', text: '这是第二段测试文字。', begin: 1500, end: 2860 },
  ],
  file_name: 'browser-test.wav',
  message: '',
  uuid: 'browser-visual-test',
}

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (request.method === 'GET' && request.url === '/health') {
    response.end(JSON.stringify(health))
    return
  }
  if (request.method === 'POST' && request.url?.startsWith('/v1/audiototext?')) {
    request.resume()
    request.on('end', () => {
      setTimeout(() => response.end(JSON.stringify(transcription)), 250)
    })
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ code: 404, message: 'not found' }))
})

server.listen(8885, '127.0.0.1', () => {
  process.stdout.write('Browser mock server ready on http://127.0.0.1:8885\n')
})
