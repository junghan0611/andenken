// Resolve hook: the pinned fixture has no built dist/. Map a missing
// <pkg>/dist/<p>.js to <pkg>/src/<p>.ts by realpath (read-only; no writes).
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const FIX = "/runtime-fixture-g2/pi/";
function alt(p) {
	if (!p.includes(FIX) || !p.includes("/dist/")) return undefined;
	const a = p.replace(/\/dist\//, "/src/").replace(/\.js$/, ".ts");
	return existsSync(a) ? pathToFileURL(realpathSync(a)).href : undefined;
}
export async function resolve(specifier, context, next) {
	try {
		const r = await next(specifier, context);
		const p = r.url.startsWith("file:") ? fileURLToPath(r.url) : "";
		const a = p && !existsSync(p) ? alt(p) : undefined;
		return a ? { ...r, url: a, format: "module-typescript" } : r;
	} catch (e) {
		const u = e?.url;
		const a = u ? alt(fileURLToPath(u)) : undefined;
		if (a) return { url: a, shortCircuit: true, format: "module-typescript" };
		throw e;
	}
}
