#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT || 37867);
const AUDIO_PATH = path.join(ROOT, 'prompt材料/bian.wav');
const USER_SCRIPT_PATH = path.join(ROOT, 'spyware-translator/spyware-translator.user.js');

const MOCK_TEXT = '滴滴出行来电,喂你好,滴滴出行网约车送车点发你电话,对对对,好的我马上过去';
const MOCK_SRT = `1
00:00:01,280 --> 00:00:02,240
滴滴出行来电,

2
00:00:03,120 --> 00:00:03,600
喂你好,

3
00:00:03,760 --> 00:00:08,080
滴滴出行网约车送车点发你电话,

4
00:00:08,080 --> 00:00:08,960
对对对,

5
00:00:10,080 --> 00:00:11,280
好的我马上过去`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, renderPage());
    }

    if (req.method === 'GET' && url.pathname === '/vx') {
      return sendHtml(res, renderVxPage());
    }

    if (req.method === 'GET' && url.pathname === '/grid') {
      return sendHtml(res, renderGridPage());
    }

    if (req.method === 'GET' && url.pathname === '/spyware-translator.user.js') {
      return sendText(res, await readFile(USER_SCRIPT_PATH, 'utf8'), 'application/javascript; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/spyfile/audiostream.wav') {
      return sendAudio(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/mock-gradio/config') {
      return sendJson(res, {
        api_prefix: '/gradio_api',
        dependencies: [
          { id: 0, api_name: 'run', inputs: [4, 5, 7, 8, 9, 10], outputs: [15, 16, 21, 18, 17] },
        ],
      });
    }

    if (req.method === 'GET' && url.pathname === '/mock-gradio/gradio_api/info') {
      return sendJson(res, {
        named_endpoints: {
          '/run': {
            parameters: [
              { label: '上传并预览音频 (支持直接拖入/在线裁剪)' },
              { label: '语种选择' },
              { label: '开启单词级时间戳' },
              { label: '跟随结果文本标点断句 (推荐)' },
              { label: '开启说话人角色识别' },
              { label: '单行最大字符数' },
            ],
            returns: [
              { label: '检测语种' },
              { label: '识别文本' },
              { label: '原始时间数据' },
              { label: '下载 SRT 字幕文件' },
              { label: 'SRT 字幕预览 (点击右上角复制)' },
            ],
          },
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/mock-gradio/gradio_api/upload') {
      await consumeRequest(req);
      return sendJson(res, ['C:\\mock\\gradio\\bian.wav']);
    }

    if (req.method === 'POST' && url.pathname === '/mock-gradio/gradio_api/call/run') {
      await consumeRequest(req);
      return sendJson(res, { event_id: `mock_${Date.now()}` });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/mock-gradio/gradio_api/call/run/')) {
      const output = ['Chinese', MOCK_TEXT, [], { path: 'C:\\mock\\Tailect_mock.srt' }, MOCK_SRT];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      });
      res.end(`event: complete\ndata: ${JSON.stringify(output)}\n\n`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error && error.stack ? error.stack : String(error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock spyware page: http://127.0.0.1:${PORT}/`);
});

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spyware Translator Mock</title>
  <script>
    window.__TAILECT_ASR_TRANSLATOR_CONFIG__ = {
      modelBaseUrl: location.origin + '/mock-gradio',
      debug: true
    };
  </script>
  <script src="/spyware-translator.user.js"></script>
  <style>
    body{margin:0;background:#f3f6fa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#172033}
    .mock-layout{display:grid;grid-template-columns:minmax(360px,1fr) minmax(420px,1fr);gap:14px;min-height:100vh;padding:14px}
    .mock-card{background:#fff;border:1px solid #dbe4ee;border-radius:8px;overflow:hidden}
    .audioBox___q8g1Z{padding:10px}
    .title___22NnR{line-height:1.7}
    .callTypeTag___397qq{display:inline-block;margin-right:6px;padding:1px 7px;border-radius:3px;background:#2563eb;color:#fff}
    .audioContainerClassical___29FNj{margin-top:8px;background:#222;color:#fff}
    .audio___13Nfv{position:relative;height:100px;padding:8px}
    .playPerson___3eXBb{position:absolute;left:8px;top:8px;display:flex;flex-direction:column;gap:28px;color:#38bdf8;font-weight:700}
    .voiceTimeline___3sCBY{position:absolute;right:8px;bottom:8px}
    wave{display:block;position:absolute;left:42px;right:8px;top:12px;height:70px;background:repeating-linear-gradient(90deg,#14532d 0 6px,transparent 6px 18px)}
    .voiceTool___3ICoa ul,.transTool___2KZkt ul{display:flex;gap:8px;align-items:center;list-style:none;margin:0;padding:10px}
    .voiceTool___3ICoa{background:#fff;color:#172033;border-top:4px solid #1890ff}
    .toolIcon___SqXnu,.play___fr87l,.stop___13bn-,.pre___6Cuzi,.next___3ZI33{display:inline-flex;align-items:center;justify-content:center;width:30px;height:28px;border:1px solid #dbe4ee;border-radius:6px;background:#fff;color:#334155}
    .footer___1sPVE{height:100%;background:#f7f8fb}
    .ant-tabs-bar{padding:14px 22px 0;border-bottom:1px solid #e5e7eb}
    .ant-tabs-tab{display:inline-block;margin-right:26px;padding:0 0 8px;color:#475569}
    .ant-tabs-tab-active{color:#1677ff;border-bottom:2px solid #1677ff}
    .voiceTrans___3y949{padding:8px}
    .transTool___2KZkt li{background:#fff}
    .transContentList___1vDgv{padding:18px 26px}
    .call___1JKG4{display:flex;align-items:flex-start;gap:10px;margin:14px 0}
    .call___1JKG4.isOther___1P7ZR{justify-content:flex-end}
    .callpic___2a_o0{width:34px;height:34px;border-radius:50%;background:#d8dee9;flex:0 0 auto}
    .textWrapper___3tIAn{max-width:78%;padding:10px 14px;border-radius:6px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    .isOther___1P7ZR .textWrapper___3tIAn{order:-1}
    audio{width:100%;margin-top:14px}
    @media(max-width:860px){.mock-layout{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main class="mock-layout">
    <section class="mock-card">
      <div class="audioBox___q8g1Z">
        <div class="title___22NnR">
          <span class="callTypeTag___397qq">在控</span><span>13212341234[被叫][广西大作]&nbsp;</span><br>
          <span class="callTypeTag___397qq">对方</span><span>8618612341234[主叫][浙江泸州]&nbsp;</span>
        </div>
        <div class="audioContainerClassical___29FNj common___IOPr4">
          <div id="audio" class="audio___13Nfv">
            <div class="playPerson___3eXBb"><span>对方</span><span>在控</span></div>
            <div class="voiceTimeline___3sCBY">00:15/00:15</div>
            <wave></wave>
          </div>
          <div class="voiceTool___3ICoa"><ul>
            <li><div class="play___fr87l" title="播放/暂停">▶</div></li>
            <li><div class="stop___13bn-" title="停止">■</div></li>
            <li><div class="pre___6Cuzi" title="上一条">‹</div></li>
            <li><div class="next___3ZI33" title="下一条">›</div></li>
          </ul></div>
        </div>
        <audio preload="auto" controls src="/spyfile/audiostream.wav?targetfile=bian.wav&index=0"></audio>
      </div>
    </section>
    <section class="mock-card footer___1sPVE">
      <div class="ant-tabs-bar">
        <div class="ant-tabs-tab ant-tabs-tab-active">转写(3)</div>
        <div class="ant-tabs-tab">要素(0)</div>
      </div>
      <div class="voiceTrans___3y949">
        <div class="transTool___2KZkt"><ul>
          <li class="toolIcon___SqXnu">T</li>
          <li class="toolIcon___SqXnu">翻</li>
          <li class="toolIcon___SqXnu">识</li>
          <li class="toolIcon___SqXnu">原</li>
        </ul></div>
        <div class="transContentList___1vDgv">
          <div class="call___1JKG4"><span class="callpic___2a_o0"></span><div class="textWrapper___3tIAn">滴滴出行、来电，喂你好，呃你在地下在地下网。</div></div>
          <div class="call___1JKG4 isOther___1P7ZR"><span class="callpic___2a_o0"></span><div class="textWrapper___3tIAn">唉你好，唉你好，对对对对号。</div></div>
          <div class="call___1JKG4"><span class="callpic___2a_o0"></span><div class="textWrapper___3tIAn">约车上车点那里对吧？啊好的，我现在马上过来。</div></div>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function renderVxPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VX Translator Mock</title>
  <script>
    window.__TAILECT_ASR_TRANSLATOR_CONFIG__ = {
      modelBaseUrl: location.origin + '/mock-gradio',
      debug: true
    };
  </script>
  <script src="/spyware-translator.user.js"></script>
  <style>
    body{margin:0;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#172033}
    .mock-vx{max-width:860px;margin:0 auto;padding:24px}
    .sessionContent___5QA1T{display:flex;flex-direction:column;gap:18px}
    .wechatContent___2F2RR{display:flex}
    .wechatContent___2F2RR.isUser___1EZ7j{justify-content:flex-end}
    .wechatContentContainer___1ZoKK{display:flex;gap:10px;max-width:620px}
    .isUser___1EZ7j .wechatContentContainer___1ZoKK{flex-direction:row-reverse}
    .user-head,.userImg___1k_lm{width:38px;height:38px;border-radius:50%;background:#cbd5e1;flex:0 0 auto}
    .wechatContentBox___-3TMw{min-width:260px}
    .wechatContentBoxTitle___3r9ay{display:flex;gap:12px;align-items:center;margin-bottom:6px;color:#64748b;font-size:12px}
    .userName___3SCkj{font-weight:700;color:#334155}
    .contentBox___3j7jw{background:#fff;border:1px solid #dbe4ee;border-radius:8px;padding:10px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    .isUser___1EZ7j .contentBox___3j7jw{background:#eff6ff;border-color:#bfdbfe}
    .audioContainer___1Ljq5{display:flex;align-items:center;gap:10px}
    .audioContainer___1GHrV{display:flex;align-items:center;gap:8px;min-width:230px}
    .play___1MKxu{width:22px;height:22px;border-radius:50%;background:#1677ff;position:relative}
    .play___1MKxu:after{content:"";position:absolute;left:8px;top:5px;border-left:8px solid #fff;border-top:5px solid transparent;border-bottom:5px solid transparent}
    .audio___OO5-R{flex:1}
    .audio___OO5-R audio{width:100%;height:28px}
    .duration___2WbnL{color:#475569;font-size:12px}
    .quote___1Qm0V{margin-top:8px;color:#334155}
    .text___3Jb9-{font-size:14px}
  </style>
</head>
<body>
  <main class="mock-vx">
    <h2>VX 语音场景 mock</h2>
    <div class="sessionContent___5QA1T">
      <div class="wechatContent___2F2RR isUser___1EZ7j">
        <div class="wechatContentContainer___1ZoKK">
          <div class="user-head userImg___1k_lm"></div>
          <div class="wechatContentBox___-3TMw">
            <div class="wechatContentBoxTitle___3r9ay"><div class="userName___3SCkj" title="145">145</div><div class="time___2MOgK">2026-03-15 12:30:09</div></div>
            <div class="wechatContentBoxBody___dCaHt">
              <div class="content___3dX7Q"><div class="contentBox___3j7jw" style="max-width: 360px;">
                <div class="audioContainer___1Ljq5"><div><div class="audioContainer___1GHrV"><div class="play___1MKxu"></div><div class="audio___OO5-R"><audio preload="auto" controls src="/spyfile/audiostream.wav?targetfile=vx-user-145.wav&index=0"></audio></div><i style="left: 0px;"></i></div></div><span class="duration___2WbnL">14s</span></div>
                <div class="quote___1Qm0V" style="font-size: 14px;">语音转写：你假如到不了也没关系</div>
              </div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="wechatContent___2F2RR">
        <div class="wechatContentContainer___1ZoKK">
          <div class="user-head userImg___1k_lm"></div>
          <div class="wechatContentBox___-3TMw">
            <div class="wechatContentBoxTitle___3r9ay"><div class="userName___3SCkj" title="陈腾(wxid_7mstafqsubkq12)">陈腾(wxid_12)</div><div class="time___2MOgK">2026-03-15 12:31:24</div></div>
            <div class="wechatContentBoxBody___dCaHt">
              <div class="content___3dX7Q"><div class="contentBox___3j7jw" style="max-width: 360px;">
                <div class="audioContainer___1Ljq5"><div><div class="audioContainer___1GHrV"><div class="play___1MKxu"></div><div class="audio___OO5-R"><audio preload="auto" controls src="/spyfile/audiostream.wav?targetfile=vx-chenteng.wav&index=0"></audio></div><i style="left: 0px;"></i></div></div><span class="duration___2WbnL">11s</span></div>
                <div class="quote___1Qm0V" style="font-size: 14px;">语音转写：好的好的我马上看</div>
              </div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="wechatContent___2F2RR">
        <div class="wechatContentContainer___1ZoKK">
          <div class="user-head userImg___1k_lm"></div>
          <div class="wechatContentBox___-3TMw">
            <div class="wechatContentBoxTitle___3r9ay"><div class="userName___3SCkj">陈腾(wxid_12)</div><div class="time___2MOgK">2026-03-15 12:32:01</div></div>
            <div class="wechatContentBoxBody___dCaHt"><div class="content___3dX7Q"><div class="contentBox___3j7jw"><div class="text___3Jb9-">好的好的</div></div></div></div>
          </div>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderGridPage() {
  const rowCells = [
    '1',
    '001专案',
    '目标',
    '12312312311(xxx)',
    '8613213213222(联通时科北京信息技术有限公司总部[来源于机主查询])',
    '主叫',
    '34',
    '2026-01-01 16:30:15',
    '已读',
    '管理员,AI',
    '管理员',
    '目标与另一方通过滴滴出行软件沟通位置和交通情况。目标提到xxxx。',
  ];
  const cells = rowCells.map((text, index) => {
    const left = [0, 60, 200, 300, 420, 577, 653, 713, 857, 957, 1038, 1119][index] || (1200 + index * 80);
    const width = [60, 140, 100, 120, 157, 76, 60, 144, 100, 81, 81, 220][index] || 100;
    return `<div class="wj-cell wj-state-multi-selected" role="gridcell" aria-selected="true" style="left:${left}px;top:0;width:${width}px;height:28px"><div>${escapeHtml(text)}</div></div>`;
  }).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grid Translator Mock</title>
  <script>
    window.__TAILECT_ASR_TRANSLATOR_CONFIG__ = {
      modelBaseUrl: location.origin + '/mock-gradio',
      debug: true
    };
  </script>
  <script src="/spyware-translator.user.js"></script>
  <style>
    body{margin:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#172033}
    .page{padding:20px}
    .rc-table{height:150px;border:1px solid #dbe4ee;background:#fff;overflow:auto}
    .wj-control{position:relative;height:100%;min-width:1500px}
    .wj-cells{position:relative;width:1500px;height:28px;margin-top:28px}
    .wj-row{position:relative;height:28px;cursor:pointer}
    .wj-cell{position:absolute;box-sizing:border-box;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#475569;background:#fff}
    .wj-row[aria-selected="true"] .wj-cell{background:#eff6ff}
    .mock-detail{display:none;margin-top:18px;grid-template-columns:1fr 1fr;gap:14px}
    .mock-detail.open{display:grid}
    .audioBox___q8g1Z{background:#fff;border:1px solid #dbe4ee;border-radius:8px;padding:10px}
    .title___22NnR{line-height:1.7}
    .callTypeTag___397qq{display:inline-block;margin-right:6px;padding:1px 7px;border-radius:3px;background:#2563eb;color:#fff}
    .audioContainerClassical___29FNj{margin-top:8px;background:#222;color:#fff}
    .audio___13Nfv{position:relative;height:100px;padding:8px}
    .voiceTimeline___3sCBY{position:absolute;right:8px;bottom:8px}
    wave{display:block;position:absolute;left:42px;right:8px;top:12px;height:70px;background:repeating-linear-gradient(90deg,#14532d 0 6px,transparent 6px 18px)}
    audio{width:100%;margin-top:12px}
    .transcript{background:#fff;border:1px solid #dbe4ee;border-radius:8px;padding:14px}
  </style>
</head>
<body>
  <main class="page">
    <h2>列表弹窗语音场景 mock</h2>
    <div class="rc-table">
      <div class="wj-control wj-content wj-flexgrid">
        <div wj-part="root">
          <div wj-part="cells" class="wj-cells" role="grid">
            <div class="wj-row" role="row" aria-selected="true" id="mock-grid-row">${cells}</div>
          </div>
        </div>
      </div>
    </div>
    <section class="mock-detail" id="mock-detail">
      <div class="audioBox___q8g1Z">
        <div class="title___22NnR">
          <span class="callTypeTag___397qq">在控</span><span>12312312311(xxx)</span><br>
          <span class="callTypeTag___397qq">对方</span><span>8613213213222</span>
        </div>
        <div class="audioContainerClassical___29FNj common___IOPr4">
          <div id="audio" class="audio___13Nfv">
            <div class="voiceTimeline___3sCBY">00:15/00:15</div>
            <wave></wave>
          </div>
        </div>
        <audio preload="auto" controls src="/spyfile/audiostream.wav?targetfile=grid-call-001.wav&index=0"></audio>
      </div>
      <div class="transcript">点击悬浮窗里的定位按钮，应高亮左上方列表项。</div>
    </section>
  </main>
  <script>
    const row = document.getElementById('mock-grid-row');
    row.addEventListener('click', () => {
      row.setAttribute('aria-selected', 'true');
      document.getElementById('mock-detail').classList.add('open');
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendAudio(req, res) {
  const bytes = await readFile(AUDIO_PATH);
  const range = req.headers.range;
  if (range) {
    const matched = String(range).match(/bytes=(\d+)-(\d*)/);
    if (matched) {
      const start = Number(matched[1]);
      const end = matched[2] ? Number(matched[2]) : bytes.length - 1;
      const chunk = bytes.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'audio/x-wav',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
        'Content-Length': chunk.length,
      });
      res.end(chunk);
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': 'audio/x-wav',
    'Accept-Ranges': 'bytes',
    'Content-Length': bytes.length,
  });
  res.end(bytes);
}

function sendHtml(res, html) {
  sendText(res, html, 'text/html; charset=utf-8');
}

function sendText(res, text, type) {
  res.writeHead(200, { 'Content-Type': type });
  res.end(text);
}

function sendJson(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function consumeRequest(req) {
  return new Promise((resolve, reject) => {
    req.on('data', () => {});
    req.on('end', resolve);
    req.on('error', reject);
  });
}
