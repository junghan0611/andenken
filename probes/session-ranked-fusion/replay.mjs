import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
assert.equal(fixture.version, 1);
assert.ok(Number.isInteger(fixture.limit) && fixture.limit > 0);
const config = Object.freeze({
	vectorWeight: 0.7, bm25Weight: 0.3, recencyHalfLifeDays: 0, minScore: 0.001,
	mergeStrategy: 'rrf', mmr: Object.freeze({ enabled: false, lambda: 0.7 }),
});
const bank = new Map(Object.entries(fixture.rows).map(([label, row]) => [label, Object.freeze({
	id: `${row.file}:${row.line}`, text: `${label} synthetic decision evidence`, sessionFile: row.file,
	project: 'synthetic', lineNumber: row.line, timestamp: '2026-01-01T00:00:00.000Z',
	role: 'user', source: fixture.eligibleSource, metadata: Object.freeze({}),
})]));
const target = bank.get(fixture.target);
assert.ok(target);
const ids = (rows) => rows.map((row) => row.id);
assert.equal(new Set(ids([...bank.values()])).size, bank.size, 'fixture IDs must be unique');
const labels = new Map([...bank].map(([label, row]) => [row.id, label]));
const order = (rows) => rows.map((row) => labels.get(row.id)).join('');
const rank = (rows) => rows.findIndex((row) => row.id === target.id) + 1;
const makeLeg = (keys, scores) => Object.freeze(keys.map((label, i) => {
	assert.ok(bank.has(label), `unknown fixture row: ${label}`);
	return Object.freeze({ ...bank.get(label), score: scores(i) });
}));
const cases = fixture.cases.map((c) => ({
	...c, vector: makeLeg(c.vector, (i) => 0.95 - i * 0.06), fts: makeLeg(c.fts, (i) => 15 - i),
}));

const builtPath = (root, file) => resolve(root, 'dist', file);
const importBuilt = (path) => import(pathToFileURL(path).href);
async function replay(root) {
	const retrieverPath = builtPath(root, 'retriever.js');
	const { retrieve } = await importBuilt(retrieverPath);
	const orderPath = builtPath(root, 'session-ranked-order.js');
	const variant = existsSync(orderPath);
	const orderRankedSessionHits = variant ? (await importBuilt(orderPath)).orderRankedSessionHits : null;
	if (variant) assert.equal(typeof orderRankedSessionHits, 'function');
	const runs = [];
	for (const c of cases) {
		const union = new Set([...ids(c.vector), ...ids(c.fts)]);
		assert.ok(union.has(target.id), `${c.name}: target must reach the retriever`);
		const postFusion = Object.freeze((await retrieve(fixture.query, c.vector, c.fts, config))
			.filter((row) => row.source === fixture.eligibleSource).map(Object.freeze));
		const ranked = orderRankedSessionHits ? orderRankedSessionHits(postFusion) : postFusion;
		assert.deepEqual(ids(ranked).sort(), ids(postFusion).sort(), `${c.name}: changed ID multiset`);
		assert.ok(ranked.every((row) => postFusion.includes(row)), `${c.name}: changed row/score`);
		for (const file of new Set(postFusion.map((row) => row.sessionFile))) {
			const forFile = (rows) => ids(rows.filter((row) => row.sessionFile === file));
			assert.deepEqual(forFile(ranked), forFile(postFusion), `${c.name}: changed order within ${file}`);
		}
		const top = ranked.slice(0, fixture.limit);
		assert.equal(top.length, Math.min(fixture.limit, postFusion.length), `${c.name}: underfilled display`);
		runs.push({ c, postFusion, ranked, receipt: { case: c.name, unionSize: union.size,
			postFusion: order(postFusion), ranked: order(ranked), top: order(top), targetRank: rank(ranked),
			status: rank(top) ? 'hit' : 'miss' } });
	}
	return { variant, retrieverPath, runs };
}

const [mode, ...roots] = process.argv.slice(2);
if (!((mode === 'gate' && roots.length === 1) || (mode === 'compare' && roots.length === 2))) {
	console.error('Usage: node replay.mjs gate <built-root> | compare <built-base-root> <built-variant-root>');
	process.exit(2);
}
try {
	// The imported computation must stay offline. No provider or store is opened.
	globalThis.fetch = async () => assert.fail('unexpected network call');
	const base = await replay(roots[0]);
	if (mode === 'gate') {
		for (const { receipt } of base.runs) console.log(JSON.stringify(receipt));
		if (base.runs.some(({ receipt }) => receipt.status === 'miss')) process.exitCode = 1;
	} else {
		const variant = await replay(roots[1]);
		assert.equal(base.variant, false, 'expected a baseline with no compiled ordering helper');
		assert.equal(variant.variant, true, 'expected the compiled variant ordering helper');
		assert.ok(readFileSync(base.retrieverPath).equals(readFileSync(variant.retrieverPath)), 'retriever.js changed');
		assert.equal(variant.runs.length, base.runs.length);
		for (const [i, b] of base.runs.entries()) {
			const v = variant.runs[i];
			assert.equal(b.c, v.c, 'fixture legs must be the same objects in both runs');
			assert.deepEqual(v.postFusion, b.postFusion, 'post-fusion inputs changed before ordering');
			assert.equal(b.receipt.targetRank, b.c.baselineRank);
			assert.equal(v.receipt.targetRank, v.c.variantRank);
			assert.equal(b.receipt.status, b.c.baselineRank <= fixture.limit ? 'hit' : 'miss');
			assert.equal(v.receipt.status, 'hit');
			console.log(JSON.stringify({ base: b.receipt, variant: v.receipt }));
		}
	}
} catch (error) {
	console.error(error);
	process.exitCode = 2; // A broken replay must not count as the expected baseline red.
}
