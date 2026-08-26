/** embedding 层：ollama/cloud 可插拔（） */
import { config } from "./config.js";
import { logger } from "./log.js";

export interface Embedder {
  name(): string;
  embed(text: string): Promise<number[] | null>;
}

export class OllamaEmbedder implements Embedder {
  constructor(private url: string, private model: string) {}
  name(): string {
    return `ollama:${this.model}`;
  }
  async embed(text: string): Promise<number[] | null> {
    try {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      const data = (await res.json()) as { embeddings?: number[][] };
      return data.embeddings?.[0] ?? null;
    } catch (e) {
      logger.warn(`Ollama embedding 失败（缓存降级）: ${String(e)}`);
      return null;
    }
  }
}

export class CloudEmbedder implements Embedder {
  constructor(private apiKey: string, private model: string, private baseUrl: string) {}
  name(): string {
    return `cloud:${this.model}`;
  }
  async embed(text: string): Promise<number[] | null> {
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      return data.data?.[0]?.embedding ?? null;
    } catch (e) {
      logger.warn(`Cloud embedding 失败（缓存降级）: ${String(e)}`);
      return null;
    }
  }
}

let embedder: Embedder | null | undefined;

export function getEmbedder(): Embedder | null {
  if (embedder !== undefined) return embedder;
  if (config.embeddingProvider === "ollama") {
    embedder = new OllamaEmbedder(config.embeddingOllamaUrl, config.embeddingModel);
  } else if (config.embeddingProvider === "cloud") {
    embedder = new CloudEmbedder(
      config.embeddingCloudApiKey,
      config.embeddingModel,
      config.embeddingCloudBaseUrl || "https://api.openai.com/v1",
    );
  } else {
    embedder = null;
    logger.info("EMBEDDING_PROVIDER 未配置，语义缓存禁用");
  }
  return embedder;
}

export async function embedText(text: string): Promise<number[] | null> {
  const e = getEmbedder();
  return e ? e.embed(text) : null;
}
