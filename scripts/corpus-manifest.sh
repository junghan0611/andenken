#!/usr/bin/env bash
# corpus-manifest.sh — inventory + integrity for the ~/repos/gh/session corpus.
#
# This is what the corpus has INSTEAD of git (GLG ruling 2026-09-02). git stored
# every jsonl as a fresh blob — 806MB packed for one commit, and a 47-minute
# secret scan on top — while buying almost nothing: the corpus is append-only
# data, so there is no diff worth reading and no history worth rewriting. What
# actually needs answering is "what do we have, and is it still intact", and a
# checksum manifest answers exactly that in seconds.
#
# Two files, one source of truth:
#   MANIFEST.json    — SSOT. relpath → {sha256, size, mtimeMs}, plus a census.
#   MANIFEST.sha256  — rendered view in `sha256sum` format, so anyone can run
#                      `cd <corpus> && sha256sum -c MANIFEST.sha256` with no
#                      tooling from this repo at all.
#
# Commands:
#   update   Hash new/changed files only (size+mtime decide), rewrite both files.
#   verify   Re-hash EVERY file and report mismatches, missing, and untracked.
#   status   Print the census without touching anything.
#
# `update` is incremental because a full re-hash of 2.9GB is wasted work when
# the corpus is append-only: a file already recorded at the same size and mtime
# cannot have changed underneath us without something being badly wrong — and
# that is what `verify` is for.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

if [ -z "${ANDENKEN_SESSION_CORPUS:-}" ] && [ -f "$HOME/.env.local" ]; then
  ANDENKEN_SESSION_CORPUS="$(set -a; . "$HOME/.env.local" >/dev/null 2>&1; printf %s "${ANDENKEN_SESSION_CORPUS:-}")"
fi
CORPUS="${ANDENKEN_SESSION_CORPUS:-$HOME/repos/gh/session}"
CORPUS="${CORPUS/#\~/$HOME}"
[ -d "$CORPUS" ] || { echo "corpus not found: $CORPUS" >&2; exit 1; }

CMD="${1:-update}"
case "$CMD" in
  update|verify|status) ;;
  --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
  *) echo "unknown command: $CMD (update|verify|status)" >&2; exit 2 ;;
esac

CORPUS="$CORPUS" python3 - "$CMD" <<'PY'
import hashlib
import json
import os
import sys
import time

cmd = sys.argv[1]
corpus = os.environ["CORPUS"]
json_path = os.path.join(corpus, "MANIFEST.json")
sha_path = os.path.join(corpus, "MANIFEST.sha256")


def walk():
	"""Every .jsonl under the corpus, as $CORPUS-relative paths, sorted."""
	out = []
	for dirpath, dirnames, filenames in os.walk(corpus):
		dirnames.sort()
		for name in sorted(filenames):
			if not name.endswith(".jsonl"):
				continue
			full = os.path.join(dirpath, name)
			out.append(os.path.relpath(full, corpus))
	return sorted(out)


def sha256(rel):
	h = hashlib.sha256()
	with open(os.path.join(corpus, rel), "rb") as f:
		# 4MB reads: the corpus median file is ~1.2MB and the largest is 23MB.
		for block in iter(lambda: f.read(4 << 20), b""):
			h.update(block)
	return h.hexdigest()


def census(files, entries):
	by_device = {}
	for rel in files:
		device = rel.split(os.sep)[0]
		d = by_device.setdefault(device, {"files": 0, "bytes": 0})
		d["files"] += 1
		d["bytes"] += entries[rel]["size"]
	return by_device


def load():
	if not os.path.exists(json_path):
		return {}
	with open(json_path) as f:
		return json.load(f).get("files", {})


def write(entries, files):
	by_device = census(files, entries)
	doc = {
		"generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
		"corpus": corpus,
		"algorithm": "sha256",
		"count": len(files),
		"bytes": sum(entries[r]["size"] for r in files),
		"devices": by_device,
		"files": {r: entries[r] for r in files},
	}
	with open(json_path, "w") as f:
		json.dump(doc, f, indent=1, sort_keys=True)
		f.write("\n")
	# `sha256sum -c` format: hash, two spaces, path.
	with open(sha_path, "w") as f:
		for r in files:
			f.write(f"{entries[r]['sha256']}  {r}\n")
	return doc


files = walk()

if cmd == "status":
	if not os.path.exists(json_path):
		print("no MANIFEST.json yet — run: ./scripts/corpus-manifest.sh update")
		sys.exit(1)
	with open(json_path) as f:
		doc = json.load(f)
	print(f"manifest: {doc['count']} files, {doc['bytes'] / 1e9:.2f} GB (generated {doc['generated']})")
	for device, d in sorted(doc["devices"].items()):
		print(f"  {device:10s} {d['files']:5d} files  {d['bytes'] / 1e9:.2f} GB")
	on_disk = len(files)
	if on_disk != doc["count"]:
		print(f"⚠ disk has {on_disk} files, manifest has {doc['count']} — run update")
	sys.exit(0)

prev = load()

if cmd == "verify":
	bad, missing = [], []
	for rel, rec in sorted(prev.items()):
		if not os.path.exists(os.path.join(corpus, rel)):
			missing.append(rel)
			continue
		if sha256(rel) != rec["sha256"]:
			bad.append(rel)
	untracked = [r for r in files if r not in prev]
	print(f"verified {len(prev)} recorded files")
	print(f"  mismatched: {len(bad)}")
	print(f"  missing:    {len(missing)}")
	print(f"  untracked:  {len(untracked)} (on disk, not in manifest)")
	for rel in (bad + missing)[:20]:
		print(f"    {rel}")
	# Untracked is normal right after a gather; mismatch/missing is not. The
	# corpus is append-only, so a changed hash means something rewrote a
	# transcript — that is the case worth failing on.
	sys.exit(1 if (bad or missing) else 0)

# --- update ---
entries = {}
hashed = 0
for rel in files:
	st = os.stat(os.path.join(corpus, rel))
	old = prev.get(rel)
	if old and old["size"] == st.st_size and old["mtimeMs"] == st.st_mtime * 1000:
		entries[rel] = old
		continue
	entries[rel] = {
		"sha256": sha256(rel),
		"size": st.st_size,
		"mtimeMs": st.st_mtime * 1000,
	}
	hashed += 1

doc = write(entries, files)
dropped = len(set(prev) - set(files))
print(f"manifest: {doc['count']} files, {doc['bytes'] / 1e9:.2f} GB")
print(f"  hashed this run: {hashed}   unchanged: {doc['count'] - hashed}   dropped: {dropped}")
for device, d in sorted(doc["devices"].items()):
	print(f"  {device:10s} {d['files']:5d} files  {d['bytes'] / 1e9:.2f} GB")
print(f"  → {json_path}")
print(f"  → {sha_path}   (verify anywhere: cd {corpus} && sha256sum -c MANIFEST.sha256)")
PY
