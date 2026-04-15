/**
 * Embedding Model Presets
 *
 * Pre-configured settings for known embedding models.
 * Used by VLLMProvider to set instruction prefixes, batch sizes, etc.
 *
 * Usage:
 *   import { getModelPreset, MODEL_PRESETS } from "./model-presets.js";
 *   const preset = getModelPreset("Qwen/Qwen3-Embedding-4B");
 *   const provider = new VLLMProvider({ ...preset, endpoint: "http://..." });
 */

export interface ModelPreset {
  model: string;           // HF model name or vLLM model path
  dimensions: number;      // native output dimensions (0 = auto-detect)
  queryInstruction: string;
  documentInstruction: string;
  maxBatchSize: number;
  notes: string;
}

/**
 * Known embedding model presets.
 *
 * Qwen3-Embedding: instruction-aware (query gets instruction, document is plain)
 * bge-m3: no instruction needed (encoder-only, not instruction-tuned)
 */
export const MODEL_PRESETS: Record<string, ModelPreset> = {
  // --- Qwen3-Embedding family ---
  "Qwen/Qwen3-Embedding-0.6B": {
    model: "Qwen/Qwen3-Embedding-0.6B",
    dimensions: 1024,
    queryInstruction: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
    documentInstruction: "",
    maxBatchSize: 64,
    notes: "1024d, 32K context. Pipeline verification model.",
  },
  "Qwen/Qwen3-Embedding-4B": {
    model: "Qwen/Qwen3-Embedding-4B",
    dimensions: 2560,
    queryInstruction: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
    documentInstruction: "",
    maxBatchSize: 32, // larger model, smaller batches for VRAM
    notes: "2560d (MRL → can truncate to 1024/768), 32K context. Primary bake-off candidate.",
  },
  "Qwen/Qwen3-Embedding-8B": {
    model: "Qwen/Qwen3-Embedding-8B",
    dimensions: 4096,
    queryInstruction: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
    documentInstruction: "",
    maxBatchSize: 16, // 8B on 16GB = tight
    notes: "4096d (MRL → can truncate), 32K context. Gemini-class quality.",
  },

  // --- Qwen3-Embedding with andenken-tuned instructions ---
  // The default Qwen instruction is generic web search.
  // For memory retrieval, a custom instruction may work better.
  // Test both in bake-off.
  "Qwen/Qwen3-Embedding-4B:memory": {
    model: "Qwen/Qwen3-Embedding-4B",
    dimensions: 2560,
    queryInstruction: "Instruct: Given a memory retrieval query, retrieve past notes, sessions, and journal entries that help reconstruct work and decisions\nQuery: ",
    documentInstruction: "",
    maxBatchSize: 32,
    notes: "Same model, andenken-specific instruction. Compare with default in bake-off.",
  },

  // --- BAAI/bge-m3 ---
  "BAAI/bge-m3": {
    model: "BAAI/bge-m3",
    dimensions: 1024,
    queryInstruction: "", // encoder-only, no instruction
    documentInstruction: "",
    maxBatchSize: 64,
    notes: "1024d, 8K context. Established multilingual baseline. No instruction-tuning.",
  },
};

/**
 * Get preset by model name. Supports:
 * - Exact match: "Qwen/Qwen3-Embedding-4B"
 * - Variant match: "Qwen/Qwen3-Embedding-4B:memory"
 * - Path match: "/storage/models/vllm/Qwen3-Embedding-4B" → "Qwen/Qwen3-Embedding-4B"
 */
export function getModelPreset(modelName: string): ModelPreset | null {
  // Exact match
  if (MODEL_PRESETS[modelName]) return MODEL_PRESETS[modelName];

  // Path → model name extraction
  const basename = modelName.split("/").pop() ?? "";

  // Try matching by basename
  for (const [key, preset] of Object.entries(MODEL_PRESETS)) {
    const presetBasename = key.split("/").pop() ?? "";
    if (presetBasename === basename) return preset;
    // Also match without variant suffix
    if (presetBasename.split(":")[0] === basename) return preset;
  }

  return null;
}

/**
 * List all available presets (for CLI help)
 */
export function listPresets(): string[] {
  return Object.keys(MODEL_PRESETS);
}
