/** 配置（.env 读取，对齐 Python 版 core/config.py） */
import "dotenv/config";

export interface Config {
  appName: string;
  dryRun: boolean;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl: string;
  contextWindowRounds: number;
  // 鉴权
  authMode: "none" | "api_key" | "jwt";
  apiKeys: string[];
  jwtPublicKeyB64: string;   // base64 单行 PEM（业务系统签发）
  jwtAlgorithm: string;
  // 存储
  vectorStore: "memory" | "sqlite";
  vectorDbPath: string;
  cacheThreshold: number;
  cacheBusting: string;
  usageStore: "memory" | "sqlite";
  usageDbPath: string;
  checkpointer: "memory" | "sqlite";
  checkpointDbPath: string;
  // embedding
  embeddingProvider: "none" | "ollama" | "cloud";
  embeddingModel: string;
  embeddingOllamaUrl: string;
  embeddingCloudApiKey: string;
  embeddingCloudBaseUrl: string;
  // 业务系统对接（商城后端；技能通过业务 API 执行）
  bizBaseUrl: string;
  bizApiKey: string;
}

function env(name: string, def = ""): string {
  return process.env[name] ?? def;
}

export const config: Config = {
  appName: env("APP_NAME", "flyer"),
  dryRun: (env("AGENT_DRY_RUN", "false") || "").toLowerCase() === "true",
  llmApiKey: env("LLM_API_KEY") || env("DEEPSEEK_API_KEY"),
  llmModel: env("LLM_MODEL", "deepseek-chat"),
  llmBaseUrl: env("LLM_BASE_URL", "https://api.deepseek.com"),
  contextWindowRounds: Number(env("CONTEXT_WINDOW_ROUNDS", "3")),

  authMode: (env("AUTH_MODE", "none") as Config["authMode"]),
  apiKeys: env("API_KEYS", "").split(",").filter(Boolean),
  jwtPublicKeyB64: env("JWT_PUBLIC_KEY"),
  jwtAlgorithm: env("JWT_ALGORITHM", "RS256"),

  vectorStore: (env("VECTOR_STORE", "memory") as Config["vectorStore"]),
  vectorDbPath: env("VECTOR_DB_PATH", "data/cache.db"),
  cacheThreshold: Number(env("CACHE_THRESHOLD", "0.9")),
  cacheBusting: env("CACHE_BUSTING", "1"),
  usageStore: (env("USAGE_STORE", "memory") as Config["usageStore"]),
  usageDbPath: env("USAGE_DB_PATH", "data/usage.db"),
  checkpointer: (env("CHECKPOINTER", "memory") as Config["checkpointer"]),
  checkpointDbPath: env("CHECKPOINT_DB_PATH", "data/agent_checkpoints.db"),

  embeddingProvider: (env("EMBEDDING_PROVIDER", "") as Config["embeddingProvider"] || "none"),
  embeddingModel: env("EMBEDDING_MODEL", "bge-m3:567m"),
  embeddingOllamaUrl: env("EMBEDDING_OLLAMA_URL", "http://localhost:11434"),
  embeddingCloudApiKey: env("EMBEDDING_CLOUD_API_KEY"),
  embeddingCloudBaseUrl: env("EMBEDDING_CLOUD_BASE_URL"),

  bizBaseUrl: env("BIZ_BASE_URL", "http://127.0.0.1:9000"),
  bizApiKey: env("BIZ_API_KEY", "dev-biz-key"),
};

/** JWT 公钥解码（base64 单行 → PEM） */
export function jwtPublicKey(): string {
  if (!config.jwtPublicKeyB64) return "";
  const b64 = config.jwtPublicKeyB64 + "=".repeat((-config.jwtPublicKeyB64.length % 4 + 4) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}
