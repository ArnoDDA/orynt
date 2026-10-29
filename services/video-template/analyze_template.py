#!/usr/bin/env python3
"""Analyze a local reference video without network access."""

import argparse
import json
import math
from pathlib import Path

import cv2
from scenedetect import SceneManager, open_video
from scenedetect.detectors import AdaptiveDetector


MAX_DURATION_SECONDS = 90.0
MAX_SCENES = 12


def compact_scenes(scene_ranges):
    if len(scene_ranges) <= MAX_SCENES:
        return scene_ranges
    bucket_size = math.ceil(len(scene_ranges) / MAX_SCENES)
    return [
        (scene_ranges[index][0], scene_ranges[min(index + bucket_size, len(scene_ranges)) - 1][1])
        for index in range(0, len(scene_ranges), bucket_size)
    ]


def analyze(input_path, output_dir):
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise ValueError("无法读取该视频，请确认文件未损坏。")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if fps <= 0 or frame_count <= 0 or width <= 0 or height <= 0:
        capture.release()
        raise ValueError("无法识别视频时长或画面尺寸。")
    duration = frame_count / fps
    if duration > MAX_DURATION_SECONDS + 0.1:
        capture.release()
        raise ValueError("参考模板最长为 90 秒。")

    video = open_video(str(input_path))
    manager = SceneManager()
    manager.add_detector(AdaptiveDetector())
    manager.detect_scenes(video=video, show_progress=False)
    detected = manager.get_scene_list(start_in_scene=True)
    scene_ranges = [(start.get_seconds(), end.get_seconds()) for start, end in detected]
    if not scene_ranges:
        scene_ranges = [(0.0, duration)]
    scene_ranges = compact_scenes(scene_ranges)

    output_dir.mkdir(parents=True, exist_ok=True)
    scenes = []
    for index, (start, end) in enumerate(scene_ranges):
        start = max(0.0, min(float(start), duration))
        end = max(start, min(float(end), duration))
        keyframe_time = min(duration, start + max(0.0, end - start) / 2)
        capture.set(cv2.CAP_PROP_POS_MSEC, keyframe_time * 1000)
        ok, frame = capture.read()
        if not ok:
            capture.set(cv2.CAP_PROP_POS_FRAMES, min(frame_count - 1, int(keyframe_time * fps)))
            ok, frame = capture.read()
        if not ok:
            capture.release()
            raise ValueError(f"无法提取第 {index + 1} 个镜头的关键帧。")
        filename = f"scene-{index + 1:02d}.jpg"
        if not cv2.imwrite(str(output_dir / filename), frame, [cv2.IMWRITE_JPEG_QUALITY, 82]):
            capture.release()
            raise ValueError(f"无法保存第 {index + 1} 个镜头的关键帧。")
        scenes.append({
            "index": index,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "keyframeTime": round(keyframe_time, 3),
            "keyframeFile": filename,
            "keyframeMime": "image/jpeg",
        })
    capture.release()
    return {
        "duration": round(duration, 3),
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "aspectRatio": f"{width}:{height}",
        "sceneCount": len(scenes),
        "detector": "AdaptiveDetector",
        "analysisEngine": "pyscenedetect-0.7.1",
        "scenes": scenes,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    print(json.dumps(analyze(Path(args.input), Path(args.output_dir)), ensure_ascii=False))


if __name__ == "__main__":
    main()
