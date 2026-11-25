/**
 * profile-preflight — fail-closed runtime check for a profiled provider,
 * replacing the shell `curl … | len(embedding)` dimension probe.
 *
 *   tsx scripts/profile-preflight.ts <sessions|md> [--identity-only]
 *
 * 1. builds the track provider from env (`ANDENKEN_<NS>_PROFILE` required)
 * 2. runtime identity: Ollama `/api/tags` digest == profile digest
 *    (profiles without a digest surface skip this step by name)
 * 3. unless --identity-only: ONE probe request, validated like every reply
 *    (count, index, dimension, finite, non-zero, model echo)
 *
 * Prints one JSON line; exit 0 only when every step passed. API: one local
 * request for the identity, one for the probe. Never writes anything.
 */

import { createMdProviderFromEnv, createSessionProviderFromEnv, VLLMProvider } from "../embedding-provider.ts";
import { profileFingerprint, verifyRuntimeIdentity } from "../embedding-profile.ts";

const [track, ...rest] = process.argv.slice(2);
const identityOnly = rest.includes("--identity-only");
const out = (o: Record<string, unknown>, rc: number): never => {
	console.log(JSON.stringify(o));
	process.exit(rc);
};

if (track !== "sessions" && track !== "md") out({ ok: false, code: "usage", usage: "profile-preflight.ts <sessions|md> [--identity-only]" }, 2);
const ns = track === "sessions" ? "ANDENKEN_SESSION_" : "ANDENKEN_MD_";
if (!process.env[`${ns}PROFILE`]) out({ ok: false, code: "profile-not-set", env: `${ns}PROFILE` }, 2);

const provider = track === "sessions" ? createSessionProviderFromEnv() : createMdProviderFromEnv();
if (!(provider instanceof VLLMProvider) || !provider.profile) out({ ok: false, code: "provider-refused" }, 1);
const p = (provider as VLLMProvider).profile!;
const base = { track, profile: p.id, fingerprint: profileFingerprint(p), dimensions: p.dimensions };
const ep = (provider as VLLMProvider).endpoint;

const id = await verifyRuntimeIdentity(p, ep);
if (!id.ok && id.code !== "no-digest-surface") out({ ...base, ok: false, code: id.code }, 1);
if (identityOnly) out({ ...base, ok: true, identity: id.ok ? "digest-match" : "no-digest-surface" }, 0);
try {
	const v = await (provider as VLLMProvider).embedDocumentBatch(["andenken profile preflight probe"]);
	if (v.length !== 1 || v[0].length !== p.dimensions) out({ ...base, ok: false, code: "probe-shape" }, 1);
	out({ ...base, ok: true, identity: id.ok ? "digest-match" : "no-digest-surface", probe: "ok" }, 0);
} catch (e) {
	out({ ...base, ok: false, code: (e as { code?: string }).code ?? "probe-failed" }, 1);
}
