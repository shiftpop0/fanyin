#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
流式识别 REST API 客户端测试脚本。
在 run_streaming_test.sh 启动服务后运行。

用法:
  python3 script/run_streaming_test_client.py
  python3 script/run_streaming_test_client.py --url http://localhost:6007
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import urllib.error

import numpy as np


def post(url: str, data: bytes = b"") -> dict:
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
    try:
        r = urllib.request.urlopen(req, timeout=120)
        return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  [ERROR] HTTP {e.code}: {e.read().decode()}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"  [ERROR] 无法连接: {e.reason}")
        print(f"  请确认服务已启动 (bash script/run_streaming_test.sh)")
        sys.exit(1)


def generate_test_audio(duration_sec: float = 5.0, sr: int = 16000) -> np.ndarray:
    """生成测试用合成音频（正弦波 + 噪声）。"""
    t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False)
    wav = (np.sin(2 * np.pi * 440 * t) * 0.3 +
           np.sin(2 * np.pi * 880 * t) * 0.2 +
           np.random.randn(len(t)) * 0.01)
    return wav.astype(np.float32)


def main():
    p = argparse.ArgumentParser(description="Tailect 流式识别客户端测试")
    p.add_argument("--url", default="http://localhost:6007", help="服务地址")
    p.add_argument("--duration", type=float, default=5.0, help="测试音频时长（秒）")
    p.add_argument("--chunk-sec", type=float, default=1.0, help="每块音频时长（秒）")
    args = p.parse_args()

    base = args.url.rstrip("/")

    print("=" * 55)
    print("  Tailect 流式识别 - 客户端测试")
    print("=" * 55)

    # 1. 健康检查
    print(f"\n[1/5] 健康检查 {base}/health ...")
    try:
        r = urllib.request.urlopen(f"{base}/health", timeout=10)
        health = json.loads(r.read().decode())
        print(f"      状态: {json.dumps(health, indent=2)}")
        if not health.get("model_loaded"):
            print("      [错误] 模型未加载，请等待服务就绪")
            sys.exit(1)
    except Exception as e:
        print(f"      [错误] 无法连接服务: {e}")
        print(f"      请先运行: bash script/run_streaming_test.sh")
        sys.exit(1)

    # 2. 创建 session
    print(f"\n[2/5] 创建流式 session ...")
    r = post(f"{base}/api/stream/start")
    sid = r["session_id"]
    print(f"      session_id: {sid}")

    # 3. 生成测试音频
    print(f"\n[3/5] 生成测试音频 ({args.duration}s, 16kHz mono) ...")
    wav = generate_test_audio(args.duration)
    print(f"      音频大小: {len(wav)} samples, {len(wav) * 4 / 1024:.1f} KB")

    # 4. 逐块发送
    sr = 16000
    chunk_samples = int(args.chunk_sec * sr)
    chunks = list(range(0, len(wav), chunk_samples))
    print(f"\n[4/5] 发送 {len(chunks)} 个音频块 (每块 {args.chunk_sec}s) ...")

    for i in chunks:
        chunk = wav[i:i + chunk_samples]
        r = post(
            f"{base}/api/stream/chunk?session_id={sid}",
            data=chunk.tobytes(),
        )
        text = r.get("text", "")
        lang = r.get("language", "")
        print(f"      t={i / sr:4.1f}s  [{lang:8s}]  '{text}'")

    # 5. 结束识别
    print(f"\n[5/5] 结束流式识别 ...")
    r = post(f"{base}/api/stream/finish?session_id={sid}")
    print(f"      最终语言: {r.get('language', '')}")
    print(f"      最终文本: {r.get('text', '')}")

    print("\n" + "=" * 55)
    print("  ✅ 测试完成！")
    print("=" * 55)


if __name__ == "__main__":
    main()
