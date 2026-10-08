"""Video QA. Exit 1 unless: 1920x1080, 30 fps, length <= 2:30, -14 +-1 LUFS, true peak <= -1 dBTP,
no silence > 0.6 s inside the narration (first caption start to last caption end).
Writes full-size frames every 2 s (1920 px wide) to <qa>/frames for review.
Usage: python3 scripts/video/qa.py out.mp4 qa_dir"""
import json, pathlib, re, shutil, subprocess, sys
V, OUT = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
fails, notes = [], []
pj = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", str(V)], capture_output=True, text=True, check=True).stdout)
st = pj["streams"][0]; w, h = st["width"], st["height"]; fps = eval(st["r_frame_rate"]); dur = float(pj["format"]["duration"])
(fails if (w, h) != (1920, 1080) else notes).append(f"resolution {w}x{h}")
(fails if abs(fps - 30) > .01 else notes).append(f"{fps:g} fps")
(fails if dur > 150 else notes).append(f"length {int(dur // 60)}:{dur % 60:04.1f}")
r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(V), "-af", "loudnorm=I=-14:TP=-1.5:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
m = json.loads(re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", r)[-1]); li, tp = float(m["input_i"]), float(m["input_tp"])
(fails if not -15 <= li <= -13 else notes).append(f"loudness {li:.1f} LUFS")
(fails if tp > -1.0 else notes).append(f"true peak {tp:.1f} dBTP")
srt = V.with_suffix(".srt").read_text()
tt = [sum(float(x) * k for x, k in zip(re.split("[:,]", t)[:3], (3600, 60, 1))) + int(t[-3:]) / 1000 for t in re.findall(r"(\d\d:\d\d:\d\d,\d\d\d)", srt)]
first, last = tt[0], tt[-1]
sd = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(V), "-af", "silencedetect=n=-45dB:d=0.6", "-f", "null", "-"], capture_output=True, text=True).stderr
ss = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", sd)]; se = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sd)]
long = [(s, e) for s, e in zip(ss, se + [9e9] * (len(ss) - len(se))) if e > first + 0.05 and s < last - 0.05]
(fails if long else notes).append(f"silences > 0.6 s inside narration: {len(long)}" + (" at " + ", ".join(f"{s:.1f}-{e:.1f}s" for s, e in long) if long else ""))
fr = OUT / "frames"; shutil.rmtree(fr, ignore_errors=True); fr.mkdir()
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(V), "-vf", "select='not(mod(n\\,60))'", "-fps_mode", "vfr", "-q:v", "3", str(fr / "f%03d.jpg")], check=True)
for i, f in enumerate(sorted(fr.glob("f*.jpg"))): f.rename(fr / f"t{i * 2:03d}s.jpg")
rep = {"pass": not fails, "fails": fails, "checks": notes, "frames": str(fr), "count": len(list(fr.glob("*.jpg")))}
(OUT / "report.json").write_text(json.dumps(rep, indent=2))
print("QA " + ("PASS" if not fails else "FAIL") + "\n  " + "\n  ".join(notes + ["FAIL: " + x for x in fails]) + f"\n  {rep['count']} frames in {fr}")
sys.exit(1 if fails else 0)
