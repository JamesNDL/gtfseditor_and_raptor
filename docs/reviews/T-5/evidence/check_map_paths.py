"""Peer review T-5: check the file paths named in docs/codebase-map.md exist.

Run from the repository root of the checkout under review:
    python check_map_paths.py docs/codebase-map.md
Each backticked token that looks like a path is looked up from the repo root and from a few
likely bases (the app or package folder). Tokens in the "Planned layout" part are reported
separately, since most of those are not meant to exist yet.
"""

import os
import re
import sys

BASES = [
    "",
    "apps/web/",
    "apps/web/src/",
    "apps/web/src/inspector/",
    "apps/web/src/timeline/",
    "apps/web/src/sim/",
    "apps/api/",
    "apps/api/src/",
    "packages/core/src/",
    "packages/gtfs/",
    "packages/gtfs/src/",
    "packages/gtfs/src/import/",
    "packages/gtfs/sql/",
    "services/router/",
]
EXT = re.compile(r"\.(ts|tsx|mjs|md|sql|css|java|json)$")


def looks_like_path(tok: str) -> bool:
    if " " in tok or tok.startswith(("/api", "?", "--", "npm ")):
        return False
    return "/" in tok or bool(EXT.search(tok))


def exists(tok: str) -> str | None:
    tok = tok.rstrip("/")
    if "*" in tok or "..." in tok:
        return "pattern (checked by hand)"
    for base in BASES:
        if os.path.exists(base + tok):
            return base + tok
    return None


def main(path: str) -> None:
    text = open(path, encoding="utf-8").read()
    existing, planned = text.split("## Planned layout", 1)
    print("== Existing parts (everything before '## Planned layout') ==")
    seen: set[str] = set()
    for tok in re.findall(r"`([^`]+)`", existing):
        if not looks_like_path(tok) or tok in seen:
            continue
        seen.add(tok)
        found = exists(tok)
        print(("OK      " if found else "MISSING ") + tok + (f"  -> {found}" if found else ""))
    print()
    print("== Files named in the planned layout that should exist today (by today's name) ==")
    for name in sorted(set(re.findall(r"[A-Za-z][\w.-]*\.(?:tsx?|css|sql)", planned))):
        hits = [
            os.path.join(root, name)
            for root, _dirs, files in os.walk(".")
            if name in files
            and "node_modules" not in root
            and ".claude" not in root
            and not root.startswith("./data")
        ]
        print(("today   " if hits else "new     ") + name + (f"  {hits[0]}" if hits else ""))


if __name__ == "__main__":
    main(sys.argv[1])
