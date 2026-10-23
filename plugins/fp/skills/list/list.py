#!/usr/bin/env python3
"""List the installed Fer Patel skills (folders named fp-*), personal and project level.

  python3 list.py          # a readable table
  python3 list.py --json   # the same as JSON
"""
import json, os, re, sys

import glob
CFG = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
roots = [("personal", os.path.join(CFG, "skills")), ("project", os.path.join(os.getcwd(), ".claude", "skills"))]
# the free fp plugin (from the fp-skills-free marketplace) keeps its skills in the plugin cache: /fp:<name>
roots += [("plugin", d) for d in sorted(glob.glob(os.path.join(CFG, "plugins", "cache", "*", "fp", "*", "skills")))]
found, seen = [], set()
for scope, root in roots:
    if not os.path.isdir(root):
        continue
    for name in sorted(os.listdir(root)):
        md = os.path.join(root, name, "SKILL.md")
        if (scope != "plugin" and not name.startswith("fp-")) or not os.path.isfile(md) or (scope, name) in seen:
            continue
        seen.add((scope, name))
        text = open(md, encoding="utf8", errors="ignore").read()
        m = re.search(r'^description:\s*"?(.*?)"?\s*$', text, re.M)
        desc = re.sub(r"^By Fer Patel \(ferpatel\.ai\)\.\s*", "", m.group(1) if m else "")
        pitch = re.split(r"(?<=[.!?])\s", desc, maxsplit=1)[0]
        if len(pitch) > 140:
            pitch = pitch[:137].rsplit(" ", 1)[0] + "..."
        ver_file = os.path.join(root, name, "VERSION")
        ver = open(ver_file).read().strip() if os.path.isfile(ver_file) else ""
        found.append({"command": ("/fp:" if scope == "plugin" else "/") + name, "name": name, "what": pitch, "version": ver, "scope": scope})

if "--json" in sys.argv:
    print(json.dumps(found, indent=1))
elif not found:
    print("No Fer Patel (fp-) skills installed yet. Get them at https://ferpatel.ai")
else:
    w = max(len(f["command"]) for f in found)
    for f in found:
        print(f'{f["command"]:<{w}}  {f["version"]:<7} {f["what"]}' + {"project": "  [this project]", "plugin": "  [free plugin]"}.get(f["scope"], ""))
    print(f"\n{len(found)} Fer Patel skill(s). More at https://ferpatel.ai")
