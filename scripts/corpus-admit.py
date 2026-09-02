#!/usr/bin/env python3
"""
corpus-admit.py — list session files admitted into the ~/repos/gh/session corpus.

Prints one $HOME-relative path per line, so the output feeds `rsync --files-from`
with `$HOME` as the source root. Runs on any machine with stdlib python only:
gather-corpus.sh pipes this file to `ssh oracle python3 -` to enumerate the
remote side, so it must never import anything outside the standard library and
must never depend on an andenken checkout being present.

The admission predicate MIRRORS session-indexer.ts (findSessionFiles + scanDir +
scanClaudeDir). Keep the two in step; if the indexer's rule moves, this moves:
  - tmp project dirs excluded on both runtimes (name starts with "tmp" once
    wrapping hyphens are stripped)
  - claude `subagents/` dirs skipped
  - pi admits only the current native filename suffix `_<UUIDv7>.jsonl`
  - size > 300KB on both runtimes
"""
import os
import re
import sys

MIN_SESSION_SIZE_BYTES = 300 * 1024

# RFC 9562 UUIDv7: version nibble 7, variant [89ab]. Suffix only — the
# created-at prefix is deliberately not validated (see session-indexer.ts).
NATIVE_PI_SUFFIX = re.compile(
    r"_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$"
)


def is_excluded_project_dir(name: str) -> bool:
    return name.strip("-").startswith("tmp")


def walk(root: str, pi: bool):
    """Yield admitted absolute paths under one runtime root."""
    if not os.path.isdir(root):
        return
    for subdir in sorted(os.listdir(root)):
        if is_excluded_project_dir(subdir):
            continue
        project_dir = os.path.join(root, subdir)
        if not os.path.isdir(project_dir):
            continue
        for dirpath, dirnames, filenames in os.walk(project_dir):
            if "subagents" in dirnames:
                dirnames.remove("subagents")
            for name in sorted(filenames):
                if not name.endswith(".jsonl"):
                    continue
                if pi and not NATIVE_PI_SUFFIX.search(name):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    if os.path.getsize(path) <= MIN_SESSION_SIZE_BYTES:
                        continue
                except OSError:
                    continue
                yield path


def main() -> int:
    home = os.path.expanduser("~")
    roots = (
        (os.path.join(home, ".pi", "agent", "sessions"), True),
        (os.path.join(home, ".claude", "projects"), False),
    )
    count = 0
    total = 0
    for root, pi in roots:
        for path in walk(root, pi):
            total += os.path.getsize(path)
            count += 1
            print(os.path.relpath(path, home))
    print(f"admitted {count} files, {total / 1e9:.2f} GB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
