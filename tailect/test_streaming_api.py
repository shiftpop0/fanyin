#!/usr/bin/env python3
"""Test streaming ASR via REST API (raw body)."""
import json, urllib.request
import numpy as np, soundfile as sf

BASE = "http://localhost:6007"

def post(path, **kw):
    url = f"{BASE}{path}"
    params = kw.get("params", {})
    if params:
        qs = "&".join(f"{k}={urllib.request.quote(str(v))}" for k,v in params.items())
        url = f"{url}?{qs}"
    data = kw.get("data")
    hdrs = kw.get("headers", {})
    r = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=hdrs, method="POST"), timeout=120)
    return json.loads(r.read().decode())

def get(path):
    return json.loads(urllib.request.urlopen(f"{BASE}{path}", timeout=120).read().decode())

# 1. Start
print("1. Creating session...")
r = post("/api/stream/start")
sid = r["session_id"]
print(f"   session_id={sid}")

# 2. Generate audio
sr = 16000; dur = 5.0
t = np.linspace(0, dur, int(sr*dur), False)
wav = (np.sin(2*np.pi*440*t)*0.3 + np.random.randn(len(t))*0.01).astype(np.float32)
sf.write("/tmp/test.wav", wav, sr)
print(f"2. Audio: {dur}s, {len(wav)} samples")

# 3. Send chunks as raw binary
cs = int(1.0 * sr)
chunks = list(range(0, len(wav), cs))
print(f"3. Sending {len(chunks)} chunks (raw body)...")
for i in chunks:
    chunk = wav[i:i+cs]
    r = post("/api/stream/chunk", params={"session_id": sid},
             data=chunk.tobytes(), headers={"Content-Type": "application/octet-stream"})
    print(f"   t={i/sr:.1f}s  text={r['text']!r}")

# 4. Finish
r = post("/api/stream/finish", params={"session_id": sid})
print(f"4. FINAL: lang={r['language']!r} text={r['text']!r}")

# 5. Health
print(f"\nHealth: {json.dumps(get('/health'))}")
print("\n✅ SUCCESS!")
