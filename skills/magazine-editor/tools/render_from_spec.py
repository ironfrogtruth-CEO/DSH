#!/usr/bin/env python3
import json, sys, pathlib

if len(sys.argv) != 4:
    print("Usage: python render_from_spec.py spec.json template.html output.html")
    sys.exit(1)

spec_path = pathlib.Path(sys.argv[1])
template_path = pathlib.Path(sys.argv[2])
out_path = pathlib.Path(sys.argv[3])

spec = json.loads(spec_path.read_text(encoding="utf-8"))
template = template_path.read_text(encoding="utf-8")
html = template.replace("__SPEC_JSON__", json.dumps(spec, ensure_ascii=False))
out_path.write_text(html, encoding="utf-8")
print(f"Wrote {out_path}")
