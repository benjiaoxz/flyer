/** JWT 用户身份断言验证（jose，RS256）
 * JWT 断言验证（jose RS256）
 */
import { importSPKI, jwtVerify } from "jose";

import { config, jwtPublicKey } from "./config.js";
import type { UserContext } from "../types/index.js";

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

export function extractBearer(authorization: string | null | undefined): string {
  if (!authorization) return "";
  const parts = authorization.split(" ");
  return parts.length === 2 && parts[0].toLowerCase() === "bearer" ? parts[1].trim() : "";
}

let cachedKeyPromise: Promise<unknown> | null = null;

async function getPublicKey(): Promise<unknown> {
  if (!cachedKeyPromise) {
    cachedKeyPromise = importSPKI(jwtPublicKey(), config.jwtAlgorithm as "RS256");
  }
  return cachedKeyPromise;
}

export async function verifyJwt(authorization: string | null | undefined): Promise<UserContext> {
  const token = extractBearer(authorization);
  if (!token) throw new PermissionError("缺少 JWT（Authorization: Bearer <token>）");
  if (!jwtPublicKey()) throw new PermissionError("JWT 公钥未配置（JWT_PUBLIC_KEY）");

  try {
    const key = await getPublicKey();
    const { payload } = await jwtVerify(token, key as never, {
      algorithms: [config.jwtAlgorithm as "RS256"],
    });
    return {
      user_id: String(payload.sub ?? ""),
      role: String(payload.role ?? "user"),
      allowed_skills: Array.isArray(payload.skills) ? payload.skills.map(String) : [],
      data_scopes: Array.isArray(payload.scopes) ? payload.scopes.map(String) : [],
      token,
      shop_id: typeof payload.shop_id === "number" ? payload.shop_id : undefined,
    };
  } catch (e) {
    throw new PermissionError(`无效 JWT: ${(e as Error).message}`);
  }
}
