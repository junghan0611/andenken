/**
 * test-support-generation.ts — TEST-ONLY helpers for the profile-only world
 * (embedding-profile.ts: the one buildable generation is ollama-bge-m3-1024).
 *
 * - `PROFILE` / `DIM` / `vec()`: fixture stores are created through
 *   VectorStore with `{ profile: PROFILE }`, so they carry a v2 stamp.
 * - `profileEnv()`: the `ANDENKEN_<NS>_*` lines that build that provider.
 * - `isolatedEnv()`: a subprocess env with a temp HOME (so ~/.env.local is
 *   never read) and a synthetic ~/.current-device (so authority gates do not
 *   depend on this host). Nothing ANDENKEN_* or credential-shaped is inherited.
 * - `startMockOllama()`: /api/tags (pinned digest) + 1024d /v1/embeddings on
 *   127.0.0.1:<random>. It lives in the test process, so it can only answer
 *   children started with async spawn (spawnSync would block it).
 *
 * `DEAD_ENDPOINT` is for subprocess tests that must not embed anything: the
 * provider's identity check cannot reach it, so any embedding attempt fails.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PROFILES } from "./embedding-profile.ts";

export const PROFILE = PROFILES["ollama-bge-m3-1024"];
export const DIM = PROFILE.dimensions;
export const DEAD_ENDPOINT = "http://127.0.0.1:9";
export const SYNTHETIC_DEVICE = "testdev";

/** `head` padded with zeros to DIM (keeps small hand-written fixtures readable). */
export function vec(...head: number[]): number[] {
  const v = new Array<number>(DIM).fill(0);
  head.forEach((x, i) => (v[i] = x));
  return v;
}

export function profileEnv(ns: "SESSION" | "MD", endpoint: string): Record<string, string> {
  return {
    [`ANDENKEN_${ns}_PROFILE`]: PROFILE.id,
    [`ANDENKEN_${ns}_PROVIDER`]: "vllm",
    [`ANDENKEN_${ns}_ENDPOINT`]: endpoint,
  };
}

/** A temp HOME holding only `.current-device`. */
export function syntheticHome(dir: string, device: string = SYNTHETIC_DEVICE): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".current-device"), `${device}\n`);
  return dir;
}

export function isolatedEnv(home: string, over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    ANDENKEN_DISABLE_RECALL_TRACKING: "1",
    ...over,
  };
}

export interface MockOllama {
  endpoint: string;
  /** Every input text sent to /v1/embeddings, in arrival order. */
  received: string[];
  /** /v1/embeddings requests. */
  requests: number;
  /** /api/tags requests. */
  tags: number;
  /** When set, every embedding request answers 400 (non-retryable in the provider). */
  failEmbeds: boolean;
  reset(): void;
  close(): Promise<void>;
}

export async function startMockOllama(): Promise<MockOllama> {
  const server = http.createServer((req, res) => {
    // Buffers first, decode once: a multi-byte character split across TCP chunks
    // would otherwise turn into replacement characters.
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/api/tags") {
        mock.tags++;
        return json(200, { models: [{ name: PROFILE.model, digest: PROFILE.digest }] });
      }
      if (req.method === "POST" && req.url === "/v1/embeddings") {
        mock.requests++;
        if (mock.failEmbeds) return json(400, { error: "synthetic failure" });
        const body = JSON.parse(Buffer.concat(parts).toString("utf-8")) as { model?: string; input: string[] };
        mock.received.push(...body.input);
        return json(200, {
          model: PROFILE.model,
          data: body.input.map((t, index) => ({ index, embedding: Array.from({ length: DIM }, (_, k) => ((t.length + k) % 7) / 7 + 0.01) })),
        });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const mock: MockOllama = {
    endpoint: `http://127.0.0.1:${port}`,
    received: [],
    requests: 0,
    tags: 0,
    failEmbeds: false,
    reset() {
      mock.received = [];
      mock.requests = 0;
      mock.tags = 0;
      mock.failEmbeds = false;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  return mock;
}
