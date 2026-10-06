#!/usr/bin/env python3
"""
extract-durable.py — read-only prototype of the proposed andenken `pi-durable`
session source. Opens a CLOSED SNAPSHOT (never a live DB) and prints the
chunks the contract would admit, plus a per-class census. API 0, stdlib only.

  python3 -I extract-durable.py <snapshot.sqlite> [--watermark N] [--json]

Contract points exercised (see the draft):
  - physical rows only (fork inheritance is NOT re-materialised)
  - classification by entry KIND + placing submission's request_id, not by role
  - receiver inheritance per conversation (RAIL 5 rule)
  - stopReason error/aborted dropped
  - project from root pi.agent cwd, cross-checked against the bucket hash
  - watermark = max(entries.id) already embedded
"""
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

SUPPORTED_SCHEMA = 1
AGENT_BRIEF = "You are a fresh visible citizen that entwurf"
COMPACTION_WRAP = re.compile(r"^The conversation history before this point was compacted into the following summary:\s*<summary>\s*(.*?)\s*</summary>\s*$", re.S)
SESSION_DIR = re.compile(r"(?:^|/)([0-9a-f]{24})/([0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/session\.sqlite$")


def project_from_cwd(cwd: str) -> str:
	# Same normalisation as session-indexer.ts extractProjectName, fed the pi dir form.
	cleaned = cwd.strip("/").replace("/", "-")
	m = re.match(r"^home-[^-]+-repos-(?:gh|work|3rd)-(.+)$", cleaned)
	if m:
		return m.group(1)
	m = re.match(r"^home-[^-]+-(.+)$", cleaned)
	if m:
		return m.group(1)
	if re.match(r"^home-[^-]+$", cleaned):
		return "home"
	return cleaned or "unknown"


def text_of(content) -> str:
	if isinstance(content, str):
		return content
	if not isinstance(content, list):
		return ""
	return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text" and c.get("text"))


def jdecode(v):
	# request_id is stored JSON-encoded ('"entwurf-doorbell:…"'); NULL stays None.
	if v is None:
		return None
	try:
		return json.loads(v)
	except (TypeError, ValueError):
		return v


def main() -> int:
	args = sys.argv[1:]
	path = args[0]
	watermark = int(args[args.index("--watermark") + 1]) if "--watermark" in args else 0
	as_json = "--json" in args
	db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)

	version = db.execute("select version from durable_schema").fetchone()[0]
	if version > SUPPORTED_SCHEMA:
		print(f"REFUSE unsupported-schema {version}", file=sys.stderr)
		return 3

	# Project / provenance: root conversation's pi.agent (documents.kind is JSON-encoded).
	row = db.execute(
		"""select r.content from documents d join document_revisions r on r.document_id = d.id
		   where d.kind = '"pi.agent"' and d.scope_kind = 'conversation' and d.owner_id = 1
		   order by r.seq desc limit 1"""
	).fetchone()
	cwd = json.loads(row[0]).get("cwd") if row else None
	m = SESSION_DIR.search(os.path.abspath(path))
	bucket, session_dir = (m.group(1), m.group(2)) if m else (None, None)
	bucket_check = None
	if cwd and bucket:
		bucket_check = hashlib.sha256(cwd.encode()).hexdigest()[:24] == bucket
	project = project_from_cwd(cwd) if cwd else "unknown"

	convs = {}
	for cid, rec in db.execute("select id, record from conversations order by id"):
		convs[cid] = json.loads(rec)
	subs = {}
	for rid, rec in db.execute("select request_id, record from submissions"):
		r = json.loads(rec)
		if "entry" in r:
			subs[r["entry"]] = (jdecode(rid), r.get("type"))

	receiver = {}
	for cid, c in convs.items():
		receiver[cid] = "agent" if "owner" in c else None  # task-owned child starts addressed by its parent agent
	census = {}
	chunks = []
	max_id = 0
	for eid, cid, seq, rec in db.execute("select id, conversation_id, commit_seq, record from entries order by id"):
		max_id = max(max_id, eid)
		e = json.loads(rec)
		kind = e.get("kind")
		msg = (e.get("model") or [None])[0]
		ts = msg.get("timestamp") if isinstance(msg, dict) else None
		cls = None
		role = None
		text = ""
		if kind == "pi.user":
			rid, _ = subs.get(eid, (None, None))
			text = text_of(msg.get("content"))
			if rid is None and not text.startswith(AGENT_BRIEF):
				cls, role = "user:human", "user"
				receiver[cid] = "human"
			elif rid is None or rid.startswith("subagent:"):
				cls = "user:agent-brief"
				receiver[cid] = "agent"
			elif rid.startswith("entwurf-doorbell:"):
				cls = "user:harness-doorbell"  # receiver unchanged
			else:
				cls = "user:unknown-origin"
				receiver[cid] = "unknown"
		elif kind == "pi.assistant":
			stop = msg.get("stopReason")
			text = text_of(msg.get("content"))
			if stop in ("error", "aborted"):
				cls = f"assistant:{stop}"
			elif not text:
				cls = "assistant:no-text"
			elif receiver.get(cid) == "human":
				cls, role = "assistant:to-human", "assistant"
			else:
				cls = f"assistant:to-{receiver.get(cid)}"
		elif kind == "pi.compaction":
			raw = text_of(msg.get("content"))
			mm = COMPACTION_WRAP.match(raw)
			text = mm.group(1) if mm else raw
			cls, role = "compaction", "compaction"
		elif kind == "pi.reset":
			if msg:
				text = text_of(msg.get("content"))
				cls, role = "reset:handoff", "compaction"
			else:
				cls = "reset:plain"
		else:
			cls = f"drop:{kind}"

		if role and role in ("user", "assistant"):
			floor = 20 if role == "user" else 100
			if len(text) <= floor:
				cls, role = cls + ":below-floor", None
		census[cls] = census.get(cls, 0) + 1
		if role and eid > watermark:
			chunks.append({
				"id": f"{path}:e{eid}",
				"lineNumber": eid,
				"role": role,
				"source": "pi-durable",
				"project": project,
				"timestamp": datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat().replace("+00:00", "Z") if ts else "",
				"metadata": {"type": cls, "entryId": str(eid), "conversationId": str(cid), "commitSeq": str(seq),
					**({"byTaskId": str(e["byTaskId"])} if "byTaskId" in e else {})},
				"text": text,
			})

	header = {"snapshot": path, "schema": version, "cwd": cwd, "project": project, "bucket": bucket,
		"bucketMatchesCwd": bucket_check, "sessionDir": session_dir, "conversations": len(convs),
		"maxEntryId": max_id, "watermarkIn": watermark, "emitted": len(chunks), "census": dict(sorted(census.items()))}
	if as_json:
		print(json.dumps({"header": header, "chunks": chunks}, ensure_ascii=False, indent=1))
	else:
		print(json.dumps(header, ensure_ascii=False, indent=1))
		for c in chunks:
			print(f'  e{c["lineNumber"]:>3} {c["role"]:<10} conv={c["metadata"]["conversationId"]:<3} {c["timestamp"]}  {c["text"][:60]!r}')
	return 0


if __name__ == "__main__":
	sys.exit(main())
