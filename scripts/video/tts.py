"""Narration: one WAV per story line with Kokoro-82M, voice af_heart (local, Apache-2.0, free).
Trims leading/trailing silence and writes durations.json. Re-voices only lines whose text changed.
Usage: ~/workspace/.video-venv/bin/python scripts/video/tts.py video/story.json video/build"""
import hashlib, json, os, sys
import numpy as np, soundfile as sf

def shorten_pauses(a, sr=24000, thr=0.01, longest=0.32):
    """Caps pauses inside a line at `longest` s, so no gap in the final video exceeds 0.5 s."""
    win = sr // 100; n = len(a) // win
    quiet = [np.max(np.abs(a[i * win:(i + 1) * win])) < thr for i in range(n)]
    keep, i, cap = [], 0, int(longest * 100)
    while i < n:
        j = i
        while j < n and quiet[j] == quiet[i]: j += 1
        run = list(range(i, j))
        if quiet[i] and len(run) > cap:
            half = cap // 2; run = run[:half] + run[-(cap - half):]
        keep += run; i = j
    out = np.concatenate([a[k * win:(k + 1) * win] for k in keep] + [a[n * win:]])
    return out

story = json.load(open(sys.argv[1])); out = os.path.join(sys.argv[2], "audio"); os.makedirs(out, exist_ok=True)
voice = story["voice"]; pipe = None; durs = {}
for ln in story["lines"]:
    say = ln.get("say", ln["text"])
    key = hashlib.sha1(f"v2|{voice}|{say}".encode()).hexdigest()[:12]
    wav, stamp = os.path.join(out, ln["id"] + ".wav"), os.path.join(out, ln["id"] + ".key")
    if not (os.path.exists(wav) and os.path.exists(stamp) and open(stamp).read() == key):
        if pipe is None:
            from kokoro import KPipeline
            pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
        a = np.concatenate([np.asarray(c) for _, _, c in pipe(say, voice=voice, speed=story.get("speed", 1.0))])
        idx = np.where(np.abs(a) > 0.01)[0]
        a = a[max(0, idx[0] - 1200): idx[-1] + 1440]  # keep 50 ms before, 60 ms after
        a = shorten_pauses(a)
        sf.write(wav, a, 24000); open(stamp, "w").write(key); print("voiced", ln["id"])
    durs[ln["id"]] = round(sf.info(wav).duration, 3)
json.dump(durs, open(os.path.join(sys.argv[2], "durations.json"), "w"), indent=1)
print("total narration %.1f s" % sum(durs.values()))
