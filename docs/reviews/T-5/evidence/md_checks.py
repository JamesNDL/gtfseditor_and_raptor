"""Peer review T-5: markdown checks.

Run from the repository root:  python md_checks.py
1. Diffs the fenced layout blocks in docs/refactor-plan.md 2.3-2.5 against the
   "Planned layout" blocks in docs/codebase-map.md.
2. Counts code fences in each changed file (must be even).
3. Checks every table row in each changed file has the same number of cells as its header.
"""

import difflib
import re

FILES = ["CLAUDE.md", "docs/codebase-map.md", "docs/architecture/system.md"]


def blocks(text: str) -> list[str]:
    return re.findall(r"^```\n(.*?)^```", text, flags=re.S | re.M)


plan = open("docs/refactor-plan.md", encoding="utf-8").read()
plan = plan[plan.index("### 2.3") : plan.index("### 2.6")]
mapped = open("docs/codebase-map.md", encoding="utf-8").read()
mapped = mapped[mapped.index("## Planned layout") :]
a, b = blocks(plan), blocks(mapped)
print(f"== Layout blocks: plan has {len(a)}, map has {len(b)} ==")
for i, (x, y) in enumerate(zip(a, b)):
    d = list(difflib.unified_diff(x.splitlines(), y.splitlines(), "plan", "map", lineterm=""))
    print(f"-- block {i + 1}: {'identical' if not d else 'differs'}")
    for line in d:
        print(line)

print()
for f in FILES:
    text = open(f, encoding="utf-8").read()
    fences = len(re.findall(r"^```", text, flags=re.M))
    print(f"== {f}: {fences} fence lines ({'even, closed' if fences % 2 == 0 else 'ODD: unclosed'}) ==")
    cols = None
    in_fence = False
    for n, line in enumerate(text.splitlines(), 1):
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not line.startswith("|"):
            cols = None if not line.startswith("|") else cols
            continue
        # Count cells, ignoring pipes inside backticks.
        stripped = re.sub(r"`[^`]*`", "x", line)
        cells = stripped.strip().strip("|").count("|") + 1
        if cols is None:
            cols = cells
        elif cells != cols:
            print(f"  line {n}: {cells} cells, header has {cols}: {line[:90]}")
    print("  table check done")
