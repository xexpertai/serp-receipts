"""Builds the final video: narration placed on the footage timeline, captions from faster-whisper word timings
(numpy audio input), loudness normalised to -14 LUFS / true peak <= -1.5 dBTP, 1920x1080 30 fps H.264.
Usage: ~/workspace/.video-venv/bin/python scripts/video/assemble.py video/story.json video/build out.mp4"""
import json, os, re, subprocess, sys
import numpy as np, soundfile as sf
from scipy.signal import resample_poly

story_p, B, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
story = json.load(open(story_p)); tl = json.load(open(f"{B}/timeline.json"))
starts = {x["id"]: x["start"] for x in tl["lines"]}
cut = max(0.0, tl["lines"][0]["start"] - 0.4)
durs = json.load(open(f"{B}/durations.json"))
last = story["lines"][-1]["id"]
length = min(tl["end"], starts[last] + durs[last] + 0.4) - cut  # end <= 0.5 s after the last word
SR = 48000
mix = np.zeros(int(length * SR) + SR, dtype=np.float32)

from faster_whisper import WhisperModel
wm = WhisperModel("small.en", device="cpu", compute_type="int8")
events = []  # (start, end, text)
for ln in story["lines"]:
    a, sr = sf.read(f"{B}/audio/{ln['id']}.wav", dtype="float32")
    off = starts[ln["id"]] - cut
    a48 = resample_poly(a, 2, 1).astype(np.float32)
    i = int(off * SR); mix[i:i + len(a48)] += a48
    if ln.get("nocaption"):
        continue
    a16 = resample_poly(a, 2, 3).astype(np.float32)
    segs, _ = wm.transcribe(a16, word_timestamps=True, language="en")
    heard = [(w.start, w.end) for s in segs for w in s.words]
    words = ln["text"].split()
    if len(heard) == len(words):
        times = heard
    else:  # spoken numbers etc. differ in count: spread script words over the heard span by length
        s0, s1 = (heard[0][0], heard[-1][1]) if heard else (0.0, len(a) / sr)
        tot = sum(len(w) + 1 for w in words); acc = 0; times = []
        for w in words:
            ws = s0 + (s1 - s0) * acc / tot; acc += len(w) + 1
            times.append((ws, s0 + (s1 - s0) * acc / tot))
        print(f"  {ln['id']}: word count {len(heard)} heard vs {len(words)} script, proportional timing")
    chunk, cs = [], None
    for w, (ws, we) in zip(words, times):
        if not chunk: cs = ws
        chunk.append(w)
        if len(" ".join(chunk)) >= 38 or w.endswith((".", "?", "!")) or (w.endswith(",") and len(chunk) >= 4):
            events.append([off + cs, off + we, " ".join(chunk)]); chunk = []
    if chunk: events.append([off + cs, off + times[-1][1], " ".join(chunk)])
for a, b in zip(events, events[1:]):  # hold a caption until the next one if the gap is short
    if b[0] - a[1] < 0.6: a[1] = b[0]

def ts(t):
    h, r = divmod(max(t, 0), 3600); m, s = divmod(r, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"
ass = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "",
       "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
       "Style: Cap,DejaVu Sans,44,&H00FFFFFF,&H00FFFFFF,&H00131510,&H00131510,0,0,0,0,100,100,0,0,1,0,0,2,120,120,47,1", "",
       "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
srt = []
for k, (s, e, t) in enumerate(events, 1):
    ass.append(f"Dialogue: 0,{ts(s)},{ts(e)},Cap,,0,0,0,,{t}")
    f = lambda x: f"{int(x // 3600):02d}:{int(x % 3600 // 60):02d}:{int(x % 60):02d},{int(x * 1000 % 1000):03d}"
    srt.append(f"{k}\n{f(s)} --> {f(e)}\n{t}\n")
open(f"{B}/captions.ass", "w").write("\n".join(ass) + "\n")
open(os.path.splitext(OUT)[0] + ".srt", "w").write("\n".join(srt))

mix = mix[: int(length * SR)]
peak = np.max(np.abs(mix));  mix = mix / peak * 0.5 if peak > 0 else mix
sf.write(f"{B}/narration.wav", mix, SR)
# two-pass loudnorm
r = subprocess.run(["ffmpeg", "-hide_banner", "-i", f"{B}/narration.wav", "-af", "acompressor=threshold=-24dB:ratio=3:attack=5:release=120:makeup=2,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
m = json.loads(re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", r)[-1])
ln = f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{cut:.3f}", "-i", f"{B}/footage.webm", "-i", f"{B}/narration.wav",
                "-filter_complex", f"[0:v]fps=30,scale=1920:940,pad=1920:1080:0:0:color=0x0f1513,ass={B}/captions.ass[v];[1:a]acompressor=threshold=-24dB:ratio=3:attack=5:release=120:makeup=2,{ln},aresample=48000,afade=t=out:st={max(0, length - 0.3):.2f}:d=0.3[a]",
                "-map", "[v]", "-map", "[a]", "-t", f"{length:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", OUT], check=True)
print(f"wrote {OUT} ({length:.1f} s, {len(events)} captions)")
