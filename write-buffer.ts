export interface BufferedRecord {
  id: string;
  text: string;
  vector: number[];
  sessionFile: string;
  project: string;
  lineNumber: number;
  timestamp: string;
  role: string;
  source?: string;
  metadata: Record<string, string>;
}

interface WriteBufferStore {
  deleteByFile(filePath: string): Promise<void>;
  addChunksRaw(chunks: BufferedRecord[]): Promise<void>;
}

/**
 * Single-writer buffer for batched LanceDB inserts.
 *
 * Why serialized?
 * - indexer.ts runs file tasks concurrently
 * - all tasks share one WriteBuffer instance
 * - without a lock, add()/flush() can interleave and append the same batch twice
 *
 * We keep embedding concurrent, but DB mutation strictly single-writer.
 */
export class WriteBuffer {
  private buffer: BufferedRecord[] = [];
  private flushed = 0;
  private deletedFiles = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private store: WriteBufferStore,
    private batchSize: number,
  ) {}

  async markFile(filePath: string): Promise<void> {
    await this.enqueue(async () => {
      if (!filePath) return;
      await this.deleteFilesOnce([filePath]);
    });
  }

  async add(records: BufferedRecord[]): Promise<void> {
    await this.enqueue(async () => {
      if (records.length === 0) return;

      const files = new Set(
        records
          .map((r) => r.sessionFile)
          .filter((f): f is string => Boolean(f)),
      );

      await this.deleteFilesOnce(files);

      this.buffer.push(...records);
      if (this.buffer.length >= this.batchSize) {
        await this.flushUnlocked();
      }
    });
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      await this.flushUnlocked();
    });
  }

  get totalFlushed(): number {
    return this.flushed + this.buffer.length;
  }

  private async enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async deleteFilesOnce(files: Iterable<string>): Promise<void> {
    for (const file of files) {
      if (!file || this.deletedFiles.has(file)) continue;
      await this.store.deleteByFile(file);
      this.deletedFiles.add(file);
    }
  }

  private async flushUnlocked(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.store.addChunksRaw(batch);
      this.flushed += batch.length;
    } catch (err) {
      this.buffer = [...batch, ...this.buffer];
      throw err;
    }
  }
}
