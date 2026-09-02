#!/usr/bin/env python3
"""redact-credentials.py — replace credential values in session JSONL.

The corpus rule is that transcripts are 정본 and are never edited. This is the
one carved-out exception, and it is narrow on purpose: only the credential VALUE
is replaced, with a same-length marker, so the surrounding turn — the command,
the filename, the reasoning that makes the session worth recalling — survives
intact. Nothing is deleted and no line is removed.

Scope: the live runtime stores AND the corpus. Redacting only the corpus would be
undone by the next gather, which rsyncs the live copy back over it.

Patterns enforce a TOKEN BOUNDARY. Without it, a prefix like `r8_`/`hf_` matches
inside urlsafe-base64 bodies (GPT reasoning signatures are full of them): the
naive form found 500 "values" of which ~460 were fragments of base64. With
boundaries the same corpus yields 20 distinct real credentials. Whenever these
two numbers are compared, they are measuring different regexes — not a change in
the data.

Usage:  redact-credentials.py scan [--exclude NAME]...
        redact-credentials.py apply [--exclude NAME]...

--exclude skips a filename; use it for the transcript being written right now,
since rewriting a file an agent is appending to is a race, not an edit.
"""
import os
import re
import sys

RULES = [
	("github-oauth", re.compile(rb"(?<![A-Za-z0-9_-])gho_[A-Za-z0-9]{36}(?![A-Za-z0-9])")),
	("slack",        re.compile(rb"(?<![A-Za-z0-9_-])xoxs-[A-Za-z0-9-]{10,}")),
	("google-ai",    re.compile(rb"(?<![A-Za-z0-9_-])AIzaSy[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])")),
	("telegram",     re.compile(rb"(?<![A-Za-z0-9_-])\d{8,10}:AA[A-Za-z0-9_-]{30,35}(?![A-Za-z0-9_-])")),
	("replicate",    re.compile(rb"(?<![A-Za-z0-9_-])r8_[A-Za-z0-9]{37}(?![A-Za-z0-9])")),
	("huggingface",  re.compile(rb"(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9])")),
]

HOME = os.path.expanduser("~")
ROOTS = [
	os.path.join(HOME, ".pi", "agent", "sessions"),
	os.path.join(HOME, ".claude", "projects"),
	os.path.join(HOME, "repos", "gh", "session"),
]


def walk_jsonl(root: str):
	"""Every .jsonl under `root`, hidden directories included.

	Not glob: `glob.glob("**/*.jsonl")` silently skips path components that
	start with a dot, and the corpus keeps each device's runtime layout —
	`<device>/.claude/projects/…`. The live roots hid that bug because their
	dot component sits in the root string rather than in the wildcard, so a
	glob-based scan reported the corpus as clean while every corpus file went
	unvisited."""
	for dirpath, _dirnames, filenames in os.walk(root):
		for name in sorted(filenames):
			if name.endswith(".jsonl"):
				yield os.path.join(dirpath, name)


def marker(name: str, n: int) -> bytes:
	"""Same-length marker. Length preservation keeps the JSON shape and byte
	offsets stable, and leaves visible evidence that something was removed
	rather than a silent gap."""
	base = f"REDACTED-{name}-".encode()
	return base + b"x" * (n - len(base)) if len(base) < n else b"R" * n


def main() -> int:
	args = sys.argv[1:]
	mode = args[0] if args else "scan"
	if mode not in ("scan", "apply"):
		print(__doc__, file=sys.stderr)
		return 2
	excludes = {args[i + 1] for i, a in enumerate(args) if a == "--exclude" and i + 1 < len(args)}

	totals, files_hit, skipped = {}, 0, 0
	for root in ROOTS:
		if not os.path.isdir(root):
			continue
		for path in walk_jsonl(root):
			if os.path.basename(path) in excludes:
				skipped += 1
				continue
			try:
				with open(path, "rb") as f:
					data = f.read()
			except OSError:
				continue
			new, hits = data, {}
			for name, rx in RULES:
				new, n = rx.subn(lambda m, _n=name: marker(_n, len(m.group(0))), new)
				if n:
					hits[name] = n
			if not hits:
				continue
			files_hit += 1
			for k, v in hits.items():
				totals[k] = totals.get(k, 0) + v
			print(f"  {sum(hits.values()):3d}  {','.join(sorted(hits)):28s} {path.replace(HOME + '/', '~/')}")
			if mode == "apply":
				assert len(new) == len(data), path
				with open(path, "wb") as f:
					f.write(new)

	print()
	print(f"{'REDACTED' if mode == 'apply' else 'FOUND'}: {sum(totals.values())} values in {files_hit} files"
	      + (f" ({skipped} excluded)" if skipped else ""))
	for k in sorted(totals):
		print(f"  {k:14s} {totals[k]}")
	return 0


if __name__ == "__main__":
	sys.exit(main())
