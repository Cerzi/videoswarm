"""Prototype: learn a requeue recipe from (draft prompt, quality prompt) with no workflow knowledge."""
import json, subprocess, sys

ROUTING = ("Any Switch", "Reroute")          # pass-through nodes: follow them, never diff them
PRIMS = ("PrimitiveInt", "PrimitiveFloat", "PrimitiveBoolean", "PrimitiveString", "PrimitiveStringMultiline")

def tags(path):
    t = json.loads(subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format_tags", "-of", "json", path],
                                  capture_output=True, text=True).stdout)["format"]["tags"]
    return json.loads(t["prompt"]), json.loads(t["requeue"])

def is_link(v): return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)

def source(p, v, seen=()):
    """Follow a link through routing nodes and primitives to a real node output or a literal."""
    while is_link(v) and v[0] in p and v[0] not in seen:
        n = p[v[0]]; seen += (v[0],)
        if n["class_type"].startswith(ROUTING):
            v = next((n["inputs"][k] for k in sorted(n["inputs"]) if k.startswith(("any_", "input"))), None)
        elif n["class_type"] in PRIMS:
            v = n["inputs"].get("value")
        else:
            return ("node", n["class_type"], v[1], v[0])
    return ("value", v)

def canonical(p, outputs=("SaveVideo",)):
    """Reachable real nodes, each input resolved to (literal) or (class of the real source node)."""
    live, stack = {}, [k for k, n in p.items() if n["class_type"] in outputs]
    while stack:
        k = stack.pop()
        if k in live: continue
        n = p[k]; ins = {}
        for name, v in n["inputs"].items():
            s = source(p, v)
            if s[0] == "node":
                ins[name] = ("from", s[1], s[2]); stack.append(s[3])
            else:
                ins[name] = s[1]
        live[k] = {"class": n["class_type"], "inputs": ins}
    return live

def key(canon, k):     # identity of a node across the two graphs: class + what feeds it (not its id)
    return canon[k]["class"]

def diff(a, b):
    ca, cb = canonical(a), canonical(b)
    ops = []
    only_a = [k for k in ca if k not in cb]; only_b = [k for k in cb if k not in ca]
    # a node that vanished and one that appeared with the same class and inputs is a routing swap, not a change
    for k in list(only_a):
        twin = next((j for j in only_b if cb[j] == ca[k]), None)
        if twin: only_a.remove(k); only_b.remove(twin)
    ops += [f"remove {ca[k]['class']} #{k} {  {n: v for n, v in ca[k]['inputs'].items() if not isinstance(v, tuple)} }" for k in only_a]
    ops += [f"add    {cb[k]['class']} #{k}" for k in only_b]
    for k in ca.keys() & cb.keys():
        for name in ca[k]["inputs"].keys() | cb[k]["inputs"].keys():
            va, vb = ca[k]["inputs"].get(name), cb[k]["inputs"].get(name)
            if va != vb and not (isinstance(va, tuple) and isinstance(vb, tuple) and va[1:] == vb[1:]):
                ops.append(f"set    {ca[k]['class']}.{name}: {va!r:.60} -> {vb!r:.60}")
    return ops

for path in sys.argv[1:]:
    final, tag = tags(path)
    print("==", path.split("/output/")[-1])
    for op in sorted(diff(tag["source_prompt"], final)):
        print("  ", op)
