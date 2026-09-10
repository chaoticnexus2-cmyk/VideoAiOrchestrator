"""
RIT Video Generator — Merge Lambda Handler
============================================
Heavy video processing: merges voiceover audio into video clips,
stitches clips together with background music and wallpaper bookends.
"""

import json
import logging
import os
import stat
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import boto3
import numpy as np
from PIL import Image

# Fix FFmpeg binary permissions (Lambda zip doesn't preserve execute bit)
try:
    import imageio_ffmpeg
    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
    if ffmpeg_path and os.path.exists(ffmpeg_path):
        os.chmod(ffmpeg_path, os.stat(ffmpeg_path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
except Exception:
    pass

# Force all temp files to /tmp (Lambda's writable directory)
os.environ["TMPDIR"] = "/tmp"
os.environ["TEMP"] = "/tmp"
os.environ["TMP"] = "/tmp"
tempfile.tempdir = "/tmp"

from moviepy import (
    AudioFileClip,
    CompositeAudioClip,
    ImageClip,
    VideoFileClip,
    concatenate_videoclips,
)
from moviepy.audio.fx import AudioFadeOut

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ASSETS_BUCKET = os.environ["ASSETS_BUCKET"]
s3 = boto3.client("s3")

VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720


# ─── S3 Helpers ───

def s3_download(key, local_path):
    s3.download_file(ASSETS_BUCKET, key, local_path)


def s3_upload(local_path, key, content_type="video/mp4"):
    s3.upload_file(local_path, ASSETS_BUCKET, key, ExtraArgs={"ContentType": content_type})


def s3_put_json(key, data):
    s3.put_object(
        Bucket=ASSETS_BUCKET,
        Key=key,
        Body=json.dumps(data),
        ContentType="application/json",
    )


def s3_list_keys(prefix):
    result = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=ASSETS_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            result.append(obj["Key"])
    return result


def s3_exists(key):
    try:
        s3.head_object(Bucket=ASSETS_BUCKET, Key=key)
        return True
    except Exception:
        return False


# ─── Video Processing ───

def resize_image_to_video(image_path):
    """Resize/crop image to match video dimensions."""
    img = Image.open(image_path).convert("RGB")
    src_w, src_h = img.size
    scale = max(VIDEO_WIDTH / src_w, VIDEO_HEIGHT / src_h)
    new_w, new_h = int(src_w * scale), int(src_h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - VIDEO_WIDTH) // 2
    top = (new_h - VIDEO_HEIGHT) // 2
    img = img.crop((left, top, left + VIDEO_WIDTH, top + VIDEO_HEIGHT))
    return np.array(img)


def _ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


# Standard encoding params so all clips are concat-compatible (stream-copy concat)
NORM_FPS = 24
NORM_VIDEO_ARGS = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-r", str(NORM_FPS),
    "-vf", f"scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop={VIDEO_WIDTH}:{VIDEO_HEIGHT},setsar=1",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
]


def image_clip_ffmpeg(image_path, audio_path, output_path, duration):
    """Create a still-image video clip with audio using FFmpeg (much faster than MoviePy)."""
    import subprocess
    ffmpeg_path = _ffmpeg()

    if audio_path:
        cmd = [
            ffmpeg_path, "-y", "-loop", "1", "-i", image_path, "-i", audio_path,
            "-t", f"{duration:.2f}",
            "-vf", f"scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop={VIDEO_WIDTH}:{VIDEO_HEIGHT},setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", str(NORM_FPS),
            "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-shortest",
            output_path,
        ]
    else:
        cmd = [
            ffmpeg_path, "-y", "-loop", "1", "-i", image_path,
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t", f"{duration:.2f}",
            "-vf", f"scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop={VIDEO_WIDTH}:{VIDEO_HEIGHT},setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", str(NORM_FPS),
            "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-shortest",
            output_path,
        ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"image_clip_ffmpeg failed: {result.stderr[:400]}")


def normalize_clip_ffmpeg(input_path, output_path):
    """Re-encode a clip to standard params so the concat demuxer can stream-copy."""
    import subprocess
    ffmpeg_path = _ffmpeg()
    cmd = [ffmpeg_path, "-y", "-i", input_path] + NORM_VIDEO_ARGS + ["-shortest", output_path]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        raise RuntimeError(f"normalize_clip_ffmpeg failed: {result.stderr[:400]}")


def concat_and_mix_ffmpeg(clip_paths, output_path, music_path=None, music_volume=0.3, music_fade=5):
    """Concatenate normalized clips (stream copy) and optionally mix background music."""
    import subprocess
    ffmpeg_path = _ffmpeg()
    tmpdir = os.path.dirname(output_path)

    list_path = os.path.join(tmpdir, "concat_list.txt")
    with open(list_path, "w") as f:
        for cp in clip_paths:
            if os.path.exists(cp):
                f.write(f"file '{cp}'\n")

    concat_out = os.path.join(tmpdir, "concat.mp4")
    concat_cmd = [ffmpeg_path, "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", concat_out]
    result = subprocess.run(concat_cmd, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        logger.warning(f"Stream-copy concat failed, re-encoding: {result.stderr[:300]}")
        concat_cmd = [ffmpeg_path, "-y", "-f", "concat", "-safe", "0", "-i", list_path] + NORM_VIDEO_ARGS + [concat_out]
        result = subprocess.run(concat_cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"concat failed: {result.stderr[:400]}")

    if not (music_path and os.path.exists(music_path)):
        os.replace(concat_out, output_path)
        return

    # Determine the final video duration so the music loops to cover it and the
    # fade-out happens at the END (not the start).
    video_dur = None
    try:
        probe = subprocess.run([ffmpeg_path, "-i", concat_out, "-f", "null", "-"],
                               capture_output=True, text=True, timeout=60)
        for line in probe.stderr.split("\n"):
            if "Duration:" in line:
                import re as _re
                m = _re.search(r"Duration:\s*(\d+):(\d+):(\d+)\.(\d+)", line)
                if m:
                    h, mi, s, cs = m.groups()
                    video_dur = int(h) * 3600 + int(mi) * 60 + int(s) + int(cs) / 100
                break
    except Exception as e:
        logger.warning(f"Could not probe video duration for music mix: {e}")

    fade = max(0, int(music_fade or 0))
    if video_dur and video_dur > 0:
        fade_start = max(0, video_dur - fade) if fade else None
        # Music: set volume, fade out at the very end, trim looped music to video length.
        music_filter = f"[1:a]volume={music_volume}"
        if fade and fade_start is not None:
            music_filter += f",afade=t=out:st={fade_start:.2f}:d={fade}"
        music_filter += f",atrim=0:{video_dur:.2f},asetpts=PTS-STARTPTS[m]"
        # Pad the narration to the full video length so music isn't cut when narration
        # is shorter, then mix. Both streams are exactly video_dur long.
        filter_complex = (
            f"{music_filter};"
            f"[0:a]apad=whole_dur={video_dur:.2f},asetpts=PTS-STARTPTS[v0];"
            f"[v0][m]amix=inputs=2:duration=longest:dropout_transition=0[a]"
        )
        mix_cmd = [
            ffmpeg_path, "-y",
            "-i", concat_out,
            "-stream_loop", "-1", "-i", music_path,
            "-filter_complex", filter_complex,
            "-map", "0:v", "-map", "[a]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            output_path,
        ]
    else:
        # Fallback: no probed duration — loop music, mix, stop at shortest stream.
        mix_cmd = [
            ffmpeg_path, "-y",
            "-i", concat_out,
            "-stream_loop", "-1", "-i", music_path,
            "-filter_complex",
            f"[1:a]volume={music_volume}[m];"
            f"[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]",
            "-map", "0:v", "-map", "[a]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
            output_path,
        ]

    result = subprocess.run(mix_cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        logger.warning(f"Music mix failed, using concat without music: {result.stderr[:300]}")
        os.replace(concat_out, output_path)


def merge_clip(video_path, audio_path, output_path):
    """Replace video's audio track with a voiceover. Strips original audio."""
    video = VideoFileClip(video_path)
    audio = AudioFileClip(audio_path)

    # If audio is shorter than video, use audio duration
    if audio.duration < video.duration:
        merged_audio = audio
    else:
        # Trim audio to video length
        merged_audio = audio.subclipped(0, video.duration)

    # REPLACE audio — strip original, use only the new voiceover
    final = video.without_audio().with_audio(merged_audio)
    final.write_videofile(output_path, codec="libx264", audio_codec="aac", logger=None)

    video.close()
    audio.close()
    final.close()


def merge_clip_ffmpeg(video_path, audio_path, output_path):
    """Fast merge using FFmpeg directly — strips original audio, adds new audio.
    Adjusts video speed to match audio duration for sync."""
    import subprocess
    import imageio_ffmpeg

    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()

    # Get video duration
    probe_cmd = [ffmpeg_path, "-i", video_path, "-f", "null", "-"]
    probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
    video_duration = None
    for line in probe_result.stderr.split('\n'):
        if 'Duration:' in line:
            import re as _re
            match = _re.search(r'Duration:\s*(\d+):(\d+):(\d+)\.(\d+)', line)
            if match:
                h, m, s, ms = match.groups()
                video_duration = int(h)*3600 + int(m)*60 + int(s) + int(ms)/100
                break

    # Get audio duration
    audio_duration = None
    probe_cmd2 = [ffmpeg_path, "-i", audio_path, "-f", "null", "-"]
    probe_result2 = subprocess.run(probe_cmd2, capture_output=True, text=True, timeout=30)
    for line in probe_result2.stderr.split('\n'):
        if 'Duration:' in line:
            import re as _re
            match = _re.search(r'Duration:\s*(\d+):(\d+):(\d+)\.(\d+)', line)
            if match:
                h, m, s, ms = match.groups()
                audio_duration = int(h)*3600 + int(m)*60 + int(s) + int(ms)/100
                break

    # Calculate speed factor to match video to audio duration
    if video_duration and audio_duration and video_duration > 0:
        speed_factor = video_duration / audio_duration
        # Clamp speed between 0.5x and 2.0x to avoid extreme distortion
        speed_factor = max(0.5, min(2.0, speed_factor))
        logger.info(f"Video: {video_duration:.1f}s, Audio: {audio_duration:.1f}s, Speed factor: {speed_factor:.3f}")

        if abs(speed_factor - 1.0) > 0.05:
            # Need to re-encode video with speed adjustment
            # setpts=PTS/speed makes video faster (speed>1) or slower (speed<1)
            pts_factor = 1.0 / speed_factor
            cmd = [
                ffmpeg_path, "-y",
                "-i", video_path,
                "-i", audio_path,
                # Scale down to 720p height (keeps aspect) so the re-encode is fast;
                # setpts adjusts playback speed to match the audio length.
                "-filter:v", f"setpts={pts_factor:.4f}*PTS,scale=-2:720",
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
                "-threads", "0",
                "-c:a", "aac",
                "-shortest",
                output_path,
            ]
        else:
            # Speed is close enough — just copy video stream (fast)
            cmd = [
                ffmpeg_path, "-y",
                "-i", video_path,
                "-i", audio_path,
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-c:v", "copy",
                "-c:a", "aac",
                "-shortest",
                output_path,
            ]
    else:
        # Couldn't determine durations — just copy
        cmd = [
            ffmpeg_path, "-y",
            "-i", video_path,
            "-i", audio_path,
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            output_path,
        ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        logger.warning(f"FFmpeg merge failed: {result.stderr[:500]}")
        # Fallback to MoviePy
        merge_clip(video_path, audio_path, output_path)
    else:
        logger.info(f"FFmpeg merge complete: {output_path}")


def stitch_clips(clip_paths, output_path, music_path=None, music_volume=0.3,
                 music_fade=5, wallpaper_path=None, wallpaper_dur=3):
    """Stitch merged clips into a final video with optional music and wallpaper bookends."""
    clips = []

    # Entry wallpaper
    if wallpaper_path and os.path.exists(wallpaper_path):
        img_array = resize_image_to_video(wallpaper_path)
        entry = ImageClip(img_array, duration=wallpaper_dur).with_fps(24)
        clips.append(entry)

    # Video clips
    for cp in clip_paths:
        if os.path.exists(cp):
            clips.append(VideoFileClip(cp))

    # Exit wallpaper
    if wallpaper_path and os.path.exists(wallpaper_path):
        img_array = resize_image_to_video(wallpaper_path)
        exit_clip = ImageClip(img_array, duration=wallpaper_dur).with_fps(24)
        clips.append(exit_clip)

    if not clips:
        raise ValueError("No clips to stitch")

    final = concatenate_videoclips(clips, method="compose")

    # Add background music
    if music_path and os.path.exists(music_path):
        music = AudioFileClip(music_path)
        # Loop music if shorter than video
        if music.duration < final.duration:
            loops_needed = int(final.duration / music.duration) + 1
            music_clips = [music] * loops_needed
            music = concatenate_videoclips(
                [AudioFileClip(music_path) for _ in range(loops_needed)]
            ).audio if hasattr(concatenate_videoclips([]), 'audio') else music

        music = music.subclipped(0, final.duration)
        music = music.with_volume_scaled(music_volume)
        if music_fade > 0:
            music = music.with_effects([AudioFadeOut(music_fade)])

        if final.audio:
            final_audio = CompositeAudioClip([final.audio, music])
        else:
            final_audio = music
        final = final.with_audio(final_audio)

    final.write_videofile(output_path, codec="libx264", audio_codec="aac", logger=None)

    for c in clips:
        c.close()
    final.close()


# ─── Lambda Handler ───

def respond(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        "body": json.dumps(body),
    }


def handler(event, context):
    """
    Invoked asynchronously by the API Lambda.
    Event is the raw JSON body (not API Gateway proxy format):
    {
        "run_id": "uuid",
        "clips": [
            {"video_key": "runs/.../clip-00.mp4", "audio_key": "runs/.../clip-00.mp3"},
            ...
        ],
        "music_key": "music/background.mp3",       // optional
        "music_volume": 0.3,                        // optional
        "music_fade": 5,                            // optional
        "wallpaper_key": "wallpapers/entry/bg.jpg", // optional
        "wallpaper_duration": 3                     // optional
    }
    """
    try:
        # MoviePy writes temp files to CWD — must be writable
        os.chdir('/tmp')

        # Handle both direct invocation and API Gateway proxy format
        if "body" in event:
            body = event.get("body", "{}")
            if event.get("isBase64Encoded"):
                import base64
                body = base64.b64decode(body).decode("utf-8")
            if isinstance(body, str):
                body = json.loads(body)
        else:
            body = event

        run_id = body.get("run_id", str(uuid.uuid4()))
        clips_config = body.get("clips", [])
        music_key = body.get("music_key")
        music_volume = body.get("music_volume", 0.3)
        music_fade = body.get("music_fade", 5)
        wallpaper_key = body.get("wallpaper_key")
        wallpaper_dur = body.get("wallpaper_duration", 3)

        if not clips_config:
            return respond(400, {"error": "clips array is required"})

        # Update status
        status_key = f"runs/{run_id}/status.json"
        s3_put_json(status_key, {
            "run_id": run_id,
            "status": "processing",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "total_clips": len(clips_config),
        })

        with tempfile.TemporaryDirectory() as tmpdir:
            merged_paths = []
            shot_duration = body.get("shot_duration", 6)

            # Download and process each clip (supports both video and image files)
            for i, clip in enumerate(clips_config):
              try:
                video_key = clip.get("video_key")
                audio_key = clip.get("audio_key")

                if not video_key:
                    continue

                # Resolve the asset — try the given key, then alternate image extensions
                # (a shot may have been saved as .jpg when Gemini fell back to SD3.5, etc.)
                if not s3_exists(video_key):
                    resolved = None
                    base = video_key.rsplit(".", 1)[0] if "." in video_key else video_key
                    for alt_ext in ("png", "jpg", "jpeg", "webp", "mp4"):
                        candidate = f"{base}.{alt_ext}"
                        if s3_exists(candidate):
                            resolved = candidate
                            break
                    if resolved:
                        logger.info(f"Clip {i}: resolved {video_key} -> {resolved}")
                        video_key = resolved
                    else:
                        logger.warning(f"Clip {i}: asset not found, skipping: {video_key}")
                        continue

                ext = video_key.rsplit(".", 1)[-1].lower()
                is_image = ext in ("jpg", "jpeg", "png", "webp")

                if is_image:
                    # Download image and create a still-image video clip via FFmpeg (fast)
                    img_local = os.path.join(tmpdir, f"img_{i}.{ext}")
                    s3_download(video_key, img_local)

                    # Determine clip duration from audio or default
                    clip_dur = shot_duration
                    audio_local = None
                    if audio_key and s3_exists(audio_key):
                        audio_ext = audio_key.rsplit(".", 1)[-1].lower()
                        audio_local = os.path.join(tmpdir, f"audio_{i}.{audio_ext}")
                        s3_download(audio_key, audio_local)
                        try:
                            a = AudioFileClip(audio_local)
                            clip_dur = max(4, a.duration + 0.5)
                            a.close()
                        except Exception:
                            pass

                    merged_local = os.path.join(tmpdir, f"merged_{i}.mp4")
                    image_clip_ffmpeg(img_local, audio_local, merged_local, clip_dur)
                    merged_paths.append(merged_local)

                else:
                    # Video file — use fast FFmpeg path (handles speed-match + audio replace)
                    video_local = os.path.join(tmpdir, f"video_{i}.mp4")
                    merged_local = os.path.join(tmpdir, f"merged_{i}.mp4")
                    s3_download(video_key, video_local)

                    if audio_key and s3_exists(audio_key):
                        audio_ext = audio_key.rsplit(".", 1)[-1].lower()
                        audio_local = os.path.join(tmpdir, f"audio_{i}.{audio_ext}")
                        s3_download(audio_key, audio_local)
                        merge_clip_ffmpeg(video_local, audio_local, merged_local)
                    else:
                        merged_local = video_local

                    # Normalize the video clip so concat can stream-copy (uniform codec/res/fps)
                    normalized_local = os.path.join(tmpdir, f"norm_{i}.mp4")
                    try:
                        normalize_clip_ffmpeg(merged_local, normalized_local)
                        merged_local = normalized_local
                    except Exception as e:
                        logger.warning(f"Normalize failed for clip {i}, using as-is: {e}")

                    merged_paths.append(merged_local)

                # Update progress
                progress = int(10 + (70 * (i + 1) / len(clips_config)))
                s3_put_json(status_key, {
                    "run_id": run_id, "status": "processing",
                    "detail": f"Processing clip {i+1}/{len(clips_config)}...",
                    "progress": progress,
                })

                # Upload merged clip
                merged_key = f"runs/{run_id}/merged/clip-{i:02d}.mp4"
                s3_upload(merged_local, merged_key)
              except Exception as clip_err:
                logger.warning(f"Clip {i} failed, skipping: {clip_err}")
                continue

            if not merged_paths:
                raise ValueError("No clips could be processed — all assets missing or failed")

            # Download music and wallpaper if provided
            music_local = None
            if music_key and s3_exists(music_key):
                music_local = os.path.join(tmpdir, "music.mp3")
                s3_download(music_key, music_local)

            wallpaper_local = None
            if wallpaper_key and s3_exists(wallpaper_key):
                wallpaper_local = os.path.join(tmpdir, "wallpaper.jpg")
                s3_download(wallpaper_key, wallpaper_local)

            # Stitch final video
            final_local = os.path.join(tmpdir, "final.mp4")

            s3_put_json(status_key, {
                "run_id": run_id, "status": "processing",
                "detail": "Assembling final video...", "progress": 85,
            })

            # Fast path: single clip, no music/wallpaper — just use it directly
            if len(merged_paths) == 1 and not music_local and not wallpaper_local:
                import shutil
                shutil.copy2(merged_paths[0], final_local)
                logger.info("Fast path: single clip, no music/wallpaper — skipped stitching")
            else:
                # Build the ordered list of clips, adding wallpaper bookends as image clips
                final_clip_paths = list(merged_paths)
                if wallpaper_local:
                    entry_clip = os.path.join(tmpdir, "wp_entry.mp4")
                    exit_clip = os.path.join(tmpdir, "wp_exit.mp4")
                    try:
                        image_clip_ffmpeg(wallpaper_local, None, entry_clip, wallpaper_dur)
                        image_clip_ffmpeg(wallpaper_local, None, exit_clip, wallpaper_dur)
                        final_clip_paths = [entry_clip] + final_clip_paths + [exit_clip]
                    except Exception as e:
                        logger.warning(f"Wallpaper bookend creation failed: {e}")

                try:
                    concat_and_mix_ffmpeg(
                        final_clip_paths, final_local,
                        music_path=music_local, music_volume=music_volume, music_fade=music_fade,
                    )
                    logger.info("FFmpeg concat + mix complete")
                except Exception as e:
                    logger.warning(f"FFmpeg assembly failed, falling back to MoviePy: {e}")
                    stitch_clips(
                        merged_paths, final_local,
                        music_path=music_local, music_volume=music_volume, music_fade=music_fade,
                        wallpaper_path=wallpaper_local, wallpaper_dur=wallpaper_dur,
                    )

            # Upload final video
            final_key = f"runs/{run_id}/output/final.mp4"
            s3_upload(final_local, final_key)

        # Update status to complete
        s3_put_json(status_key, {
            "run_id": run_id,
            "status": "complete",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "total_clips": len(clips_config),
            "output_key": final_key,
        })

        return respond(200, {
            "run_id": run_id,
            "status": "complete",
            "output_key": final_key,
        })

    except Exception as e:
        logger.exception("Merge failed")
        # Try to update status
        try:
            run_id = body.get("run_id", "unknown") if isinstance(body, dict) else "unknown"
            s3_put_json(f"runs/{run_id}/status.json", {
                "run_id": run_id,
                "status": "failed",
                "error": str(e),
                "failed_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            pass
        return respond(500, {"error": str(e)})
