"""Writes prewarm-replay.json, the planner's fixture from the replay's model.

    python3 prewarm-replay.py <dir holding simulate.py>

`simulate.py` is the replay's model, from an unpublished experiment.
`predictor` holds random histories with `Predictor.items` and
`Predictor.children`; `learn` holds random runs' jobs with what `load`
(parent inference) and `Predictor.observe` (offsets normalized to a 71 s
cold start) learn from them, as if the listener saw them.
"""
import gzip, json, os, random, sys, tempfile
from datetime import datetime, timezone

sys.path.insert(0, sys.argv[1])
from simulate import Predictor, load

random.seed(123)
iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
T0 = 1_800_000_000

predictor = []
for _ in range(25):
    hist = []
    for _ in range(random.randint(1, 6)):
        jobs = [{"name": "build", "label": "a", "offset": 0, "parent": None}]
        for _ in range(random.randint(0, 5)):
            jobs.append({"name": random.choice(["t1", "t2", "lint"]), "label": random.choice(["a", "b"]),
                         "offset": random.randint(0, 300) * 1000,
                         "parent": random.choice([None] + list(range(len(jobs))))})
        hist.append({"jobs": jobs})
    predictor.append({
        "hist": [[[j["name"], j["label"], j["offset"], -1 if j["parent"] is None else j["parent"]]
                  for j in r["jobs"]] for r in hist],
        "items": [[l, o] for l, o in Predictor.items(hist)],
        "children": [[k, [[l, n] for l, n in v]] for k, v in Predictor.children(hist).items()]})

# Runs whose jobs queue at, or just after, earlier ones' ends.
raw = []
for r in range(25):
    jobs = []
    for i in range(random.randint(1, 7)):
        ends = [j["end"] for j in jobs]
        q = (random.choice(ends) + random.choice([-1, 0, 2, 5, 6]) if ends and random.random() < 0.7
             else T0 + random.randint(0, 30))
        start = q + random.randint(5, 120)
        jobs.append({"name": f"j{random.randint(0, 3)}", "label": random.choice(["a", "b"]),
                     "q": q, "start": start, "end": start + random.randint(10, 200)})
    raw.append({"run": {"id": r + 1, "path": "ci.yml", "event": "push", "conclusion": "success"},
                "jobs": [{"name": j["name"], "labels": [j["label"]], "conclusion": "success",
                          "created_at": iso(j["q"]), "started_at": iso(j["start"]),
                          "completed_at": iso(j["end"])} for j in jobs]})
path = os.path.join(tempfile.mkdtemp(), "runs.json.gz")
json.dump({"repo": "r", "workflow": "w", "runs": raw}, gzip.open(path, "wt"))
_, _, runs = load(path)
pred = Predictor()
learn = []
for run in runs:
    run["sim_jobs"] = {j["i"]: dict(j, q=j["created"], started=j["completed_hist"] - j["dur"]) for j in run["jobs"]}
    pred.observe(run, run["end"], 71)
    steps = pred.hist[run["key"]][-1][1]["jobs"]
    learn.append({
        "jobs": [[j["name"], j["label"], int(j["created"] * 1000), int((j["completed_hist"] - j["dur"]) * 1000), int(j["completed_hist"] * 1000)] for j in run["jobs"]],
        "steps": [[s["name"], s["label"], int(round(s["offset"] * 1000)), -1 if s["parent"] is None else s["parent"]]
                  for s in steps]})

json.dump({"predictor": predictor, "learn": learn}, open(os.path.join(os.path.dirname(__file__), "prewarm-replay.json"), "w"),
          separators=(",", ":"))
