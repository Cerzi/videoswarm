"""Prototype: read a ComfyUI render by data type, with no list of known node classes."""
import json, subprocess, sys

def tags(path):
    t = json.loads(subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format_tags", "-of", "json", path],
                                  capture_output=True, text=True).stdout)["format"]["tags"]
    return json.loads(t["prompt"]), json.loads(t["workflow"]) if "workflow" in t else None

def is_link(v): return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)

def read(path):
    p, wf = tags(path)
    types = {}                                   # (node id, input name) -> socket type, from the UI graph
    out_types = {}                               # (node id, slot) -> socket type
    for n in (wf or {}).get("nodes", []):
        for i in n.get("inputs") or []:
            types[(str(n["id"]), i["name"])] = i.get("type")
        for s, o in enumerate(n.get("outputs") or []):
            out_types[(str(n["id"]), s)] = o.get("type")

    def upstream(nid, want=None, seen=None):
        """Nodes feeding nid, optionally only along links of one type (a switch passes any type on)."""
        seen = set() if seen is None else seen
        for name, v in p[nid]["inputs"].items():
            if not is_link(v) or v[0] not in p or v[0] in seen: continue
            t = out_types.get((v[0], v[1])) or types.get((nid, name))
            if want and t not in (want, "*"): continue
            seen.add(v[0]); yield v[0]; yield from upstream(v[0], want, seen)

    # the save that wrote this file, then the sampler(s): nodes turning a MODEL into a LATENT
    save = next(k for k, n in p.items() if "filename_prefix" in n["inputs"])
    feeding = [save] + list(upstream(save))
    def takes(nid, want):
        return any(t == want for (n, _), t in types.items() if n == nid)
    def direct(nid):
        return [v[0] for v in p[nid]["inputs"].values() if is_link(v) and v[0] in p]
    # A sampler turns a MODEL into a LATENT, directly or through what feeds it (a guider, sigmas).
    samplers = [k for k in feeding if any(t == "LATENT" for (n, _), t in out_types.items() if n == k)
                and (takes(k, "MODEL") or any(takes(d, "MODEL") for d in direct(k)))]
    result = {"samplers": [p[k]["class_type"] for k in samplers]}
    model_chain = list(dict.fromkeys(k for s in samplers for src in [s] + direct(s) if takes(src, "MODEL")
                                     for k in upstream(src, "MODEL")))
    roots = [k for k in model_chain if not any(t == "MODEL" for (nid, _), t in types.items() if nid == k)]
    result["model"] = sorted({v for k in roots for v in p[k]["inputs"].values() if isinstance(v, str) and v.endswith((".safetensors", ".gguf", ".ckpt", ".pt"))})
    loras = set()
    for k in model_chain:
        for name, v in p[k]["inputs"].items():
            if isinstance(v, dict) and v.get("on") and v.get("lora"): loras.add(v["lora"])
            elif isinstance(v, str) and "lora" in name.lower() and v.endswith(".safetensors"): loras.add(v)
    result["loras"] = sorted(loras)
    texts = [v for s in samplers for k in upstream(s, None) for v in p[k]["inputs"].values()
             if isinstance(v, str) and len(v.split()) >= 4 and not v.endswith((".png", ".mp4", ".safetensors"))]
    result["prompt"] = (max(texts, key=len)[:90] + "…") if texts else None
    def ints(key):
        vals = set()
        for s in samplers:
            for k in [s] + list(upstream(s)):
                for name, v in p[k]["inputs"].items():
                    if key in name.lower():
                        seen = set()
                        while is_link(v) and v[0] in p and v[0] not in seen:   # through switches and primitives
                            seen.add(v[0]); ins = p[v[0]]["inputs"]
                            v = next((x for k2, x in sorted(ins.items()) if is_link(x) or (isinstance(x, (int, float)) and not isinstance(x, bool))), None)
                        if isinstance(v, (int, float)) and not isinstance(v, bool): vals.add(v)
        return sorted(vals)
    result["seed"], result["steps"] = ints("seed"), ints("steps")
    return result

for f in sys.argv[1:]:
    try:
        r = read(f)
    except Exception as e:
        r = {"error": f"{type(e).__name__}: {e}"}
    print("==", f.split("/output/")[-1]); [print(f"   {k:<8} {v}") for k, v in r.items()]
