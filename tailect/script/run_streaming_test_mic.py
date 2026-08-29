#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎤 流式识别 — 麦克风实时测试客户端（连续模式）
对着麦克风说话，实时显示 ASR 识别结果。
服务端 VAD 自动分段，说话停顿 1.5s 自动结束一句话并继续下一句。
支持数小时连续识别。

用法:
  python script/run_streaming_test_mic.py
  python script/run_streaming_test_mic.py --url http://localhost:2300
  python script/run_streaming_test_mic.py --device 1

依赖:
  pip install sounddevice numpy requests
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from queue import Queue
from typing import Optional

import numpy as np
import requests
import sounddevice as sd


def list_microphones():
    devices = sd.query_devices()
    print("\n🎤 可用麦克风:")
    for i, dev in enumerate(devices):
        if dev["max_input_channels"] > 0:
            print(f"  [{i}] {dev['name']} ({int(dev['default_samplerate'])} Hz)")
    print()


def select_microphone(device_id: Optional[int]) -> tuple[int, int]:
    devices = sd.query_devices()
    if device_id is not None:
        info = devices[device_id]
        if info["max_input_channels"] == 0:
            print(f"[错误] 设备 {device_id} 不是输入设备")
            sys.exit(1)
        return device_id, int(info["default_samplerate"])

    default = sd.default.device[0]
    if default is None:
        for i, dev in enumerate(devices):
            if dev["max_input_channels"] > 0:
                default = i
                break
    if default is None:
        print("[错误] 未找到麦克风")
        sys.exit(1)
    return default, int(sd.query_devices(default)["default_samplerate"])


def resample(audio: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
    if orig_sr == target_sr:
        return audio.astype(np.float32)
    dur = len(audio) / orig_sr
    new_len = int(round(dur * target_sr))
    if new_len <= 0:
        return np.zeros((0,), dtype=np.float32)
    x_old = np.linspace(0, dur, len(audio), endpoint=False)
    x_new = np.linspace(0, dur, new_len, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


def main():
    p = argparse.ArgumentParser(description="🎤 流式识别麦克风测试（连续模式）")
    p.add_argument("--url", default="http://localhost:2300", help="服务地址")
    p.add_argument("--device", type=int, default=None, help="麦克风设备 ID")
    p.add_argument("--chunk-sec", type=float, default=0.5, help="每块时长(秒)")
    p.add_argument("--list-devices", action="store_true", help="列出设备")
    args = p.parse_args()

    if args.list_devices:
        list_microphones()
        return

    base = args.url.rstrip("/")

    # 健康检查
    print(f"\n🔍 检查服务 {base}/health ...")
    try:
        r = requests.get(f"{base}/health", timeout=10)
        health = r.json()
        print(f"   状态: {json.dumps(health)}")
        if not health.get("model_loaded"):
            print("[错误] 模型未加载，请先启动 run_streaming_test.sh")
            sys.exit(1)
    except Exception as e:
        print(f"[错误] 无法连接: {e}")
        sys.exit(1)

    # 选择麦克风
    list_microphones()
    dev_id, sample_rate = select_microphone(args.device)
    target_sr = 16000
    chunk_samples = int(args.chunk_sec * target_sr)

    print(f"🎤 使用: [{dev_id}] {sd.query_devices(dev_id)['name']}")
    print(f"   原始采样率: {sample_rate} Hz → {target_sr} Hz")
    print(f"   每块: {args.chunk_sec}s\n")

    # 创建连续流式 session
    print("[1/3] 创建连续流式 session ...")
    r = requests.post(f"{base}/api/stream/continuous/start")
    if r.status_code != 200:
        print(f"  [错误] HTTP {r.status_code}: {r.text[:200]}")
        sys.exit(1)
    try:
        sid = r.json()["session_id"]
    except Exception as e:
        print(f"  [错误] 响应解析失败: {e}")
        print(f"  响应内容: {r.text[:200]}")
        print(f"  提示: 容器内的代码可能是旧版，请重启服务: docker rm -f streaming-test && bash script/run_streaming_test.sh")
        sys.exit(1)
    print(f"   session_id: {sid}")

    # 后台发送线程
    audio_queue: Queue = Queue()
    stop_event = threading.Event()
    current_text = [""]  # 用于多线程间共享最新文本
    segment_count = [0]

    def mic_callback(indata, frames, time_info, status):
        if status:
            print(f"\n  [音频] {status}")
        audio_queue.put(indata[:, 0].copy())

    def send_worker():
        buffer = np.zeros((0,), dtype=np.float32)
        while not stop_event.is_set():
            try:
                while True:
                    chunk = audio_queue.get_nowait()
                    buffer = np.concatenate([buffer, chunk])
            except Exception:
                pass

            if len(buffer) >= chunk_samples:
                send = buffer[:chunk_samples]
                buffer = buffer[chunk_samples:]
                send_16k = resample(send, sample_rate, target_sr)

                try:
                    r = requests.post(
                        f"{base}/api/stream/continuous/chunk?session_id={sid}",
                        data=send_16k.tobytes(),
                        headers={"Content-Type": "application/octet-stream"},
                        timeout=30,
                    )
                    result = r.json()
                    text = result.get("text", "")
                    partial = result.get("partial", True)
                    complete = result.get("complete_text", "")
                    seg_idx = result.get("segment_index", 0)
                    seg_text = result.get("segment_text", "")

                    # 显示
                    if not partial and seg_text:
                        # 一段话完成
                        segment_count[0] = seg_idx
                        display = f"\n  ✅ [第{seg_idx}段] {seg_text}"
                        print(display)
                    elif text:
                        current_text[0] = text
                        # 实时结果覆盖在当前行
                        sys.stdout.write(f"\r  🗣️  {text[:80]:80s}")
                        sys.stdout.flush()
                except requests.exceptions.ConnectionError:
                    print(f"\n  [连接断开，服务可能已停止]")
                    stop_event.set()
                except Exception as e:
                    print(f"\n  [发送错误] {e}")

            time.sleep(0.05)

    # 启动线程
    t = threading.Thread(target=send_worker, daemon=True)
    t.start()

    # 启动麦克风
    print("[2/3] 启动麦克风，说点什么吧...")
    print("      服务端 VAD 自动分段（静音 1.5s 自动断句）")
    print("      连续说话超过 60s 自动 reset，永不卡死")
    print(f"\n{'=' * 55}")
    print("  按 [Enter] 停止并显示完整转录")
    print(f"{'=' * 55}\n")

    stream = sd.InputStream(
        device=dev_id, channels=1, samplerate=sample_rate,
        callback=mic_callback,
        blocksize=int(sample_rate * args.chunk_sec),
    )
    stream.start()

    try:
        input()
    except (EOFError, KeyboardInterrupt):
        pass

    # 停止
    print("\n\n[3/3] 结束识别 ...")
    stop_event.set()
    stream.stop()
    stream.close()

    time.sleep(0.5)
    try:
        r = requests.post(f"{base}/api/stream/continuous/finish?session_id={sid}", timeout=30)
        result = r.json()
        ct = result.get("complete_text", "")
        print(f"\n{'=' * 55}")
        print(f"  📝 完整转录 ({segment_count[0]} 段, {len(ct)} 字):")
        print(f"  {ct}")
        print(f"{'=' * 55}\n")
    except Exception as e:
        print(f"\n  [结束请求失败] {e}")


if __name__ == "__main__":
    main()
