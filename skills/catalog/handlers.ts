/**
 * catalog 技能：商家商品管理（上架/查询/改价/下架）
 *
 * 对接业务系统商品 API：X-Biz-Key（服务间鉴权）+ 透传用户 JWT（身份验证）。
 * 领域执行（业务 API 调用）在本技能；harness 负责路由/鉴权/反馈。
 */
import { config } from "../../src/core/config.js";
import { logger } from "../../src/core/log.js";
import type { GenericState, IntentResult, Skill, SkillManifest, SkillResult } from "../../src/types/index.js";

// ---------------------------------------------------------------- 业务 API 客户端
/** 调业务系统 API：X-Biz-Key + 透传用户 JWT */
async function callBizApi<T>(
  path: string,
  method: "GET" | "POST" | "PATCH",
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${config.bizBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Biz-Key": config.bizApiKey,
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { detail?: string };
  if (!res.ok) {
    throw new Error(data.detail ?? `业务系统错误 ${res.status}`);
  }
  return data as T;
}

interface Product {
  id: number;
  shop_id: number;
  name: string;
  price: number;
  stock: number;
  status: string;
}

interface ProductCreate {
  shop_id: number;
  name: string;
  price: number;
  stock: number;
  description?: string;
}

// ---------------------------------------------------------------- 技能
const manifest: SkillManifest = {
  id: "catalog",
  name: "商品管理",
  description: "商家上架/查询/修改/下架商品（对接业务系统）",
  intents: ["catalog_add", "catalog_query", "catalog_update", "catalog_off"],
  trigger_keywords: ["上架", "商品", "下架", "改价", "库存", "价格"],
  session_mode: "single",
  max_turns_per_session: 2,
  max_llm_calls_per_turn: 2,
  data_scopes: ["shop"],
};

/** 解析商品字段（确定性规则，不依赖 LLM） */
function parseProduct(text: string): { name?: string; price?: number; stock?: number } {
  const out: { name?: string; price?: number; stock?: number } = {};
  const nameMatch = text.match(/["'「」《](.+?)["'」》]/);
  if (nameMatch) out.name = nameMatch[1];
  const priceMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/);
  if (priceMatch) out.price = Number(priceMatch[1]);
  const stockMatch = text.match(/库存\s*(\d+)/);
  if (stockMatch) out.stock = Number(stockMatch[1]);
  return out;
}

const skill: Skill = {
  manifest,
  async handle(state: GenericState, intent: IntentResult, newText: string): Promise<SkillResult> {
    // JWT 用户上下文（业务系统验证身份；无 token 拒绝）
    const token = state.user_ctx?.token;
    const shopId = state.user_ctx?.shop_id;
    if (!token || !shopId) {
      return {
        status: "error",
        output: "需要业务系统登录态（JWT）才能操作商品",
        reason: "缺少用户 token/shop_id",
        data: {},
      };
    }

    try {
      const action = intent.intent.replace("catalog_", ""); // add/query/update/off
      const product = parseProduct(newText);

      switch (action) {
        case "add": {
          if (!product.name || !product.price) {
            return {
              status: "error",
              output: "上架需要商品名和价格（如：上架\"Nike 鞋\" 299元 库存50）",
              reason: "缺少商品名或价格",
              data: {},
            };
          }
          const created = await callBizApi<Product>(
            "/api/products",
            "POST",
            token,
            { shop_id: shopId, name: product.name, price: product.price, stock: product.stock ?? 0 },
          );
          return {
            status: "success",
            output: `✅ 已上架商品：${created.name}（${created.price}元，库存${created.stock}，id=${created.id}）`,
            data: { product_id: created.id },
          };
        }
        case "query": {
          const products = await callBizApi<Product[]>("/api/products", "GET", token);
          if (!products.length) {
            return { status: "success", output: "暂无商品", data: {} };
          }
          const lines = products.map(
            (p) => `${p.name}（${p.price}元，库存${p.stock}，${p.status}）`,
          );
          return { status: "success", output: `📦 商品列表：\n${lines.join("\n")}`, data: { count: products.length } };
        }
        case "update": {
          if (!product.name || (!product.price && !product.stock)) {
            return {
              status: "error",
              output: "改价/改库存需要商品名和值（如：改\"Nike 鞋\"价格 259元）",
              reason: "缺少商品名或更新值",
              data: {},
            };
          }
          const products = await callBizApi<Product[]>("/api/products", "GET", token);
          const target = products.find((p) => p.name.includes(product.name!));
          if (!target) {
            return { status: "error", output: `未找到商品「${product.name}」`, reason: "商品不存在", data: {} };
          }
          const updated = await callBizApi<Product>(
            `/api/products/${target.id}`,
            "PATCH",
            token,
            { price: product.price, stock: product.stock },
          );
          return {
            status: "success",
            output: `✏️ 已更新「${updated.name}」：${updated.price}元，库存${updated.stock}`,
            data: { product_id: updated.id },
          };
        }
        case "off": {
          if (!product.name) {
            return { status: "error", output: "下架需要商品名（如：下架\"Nike 鞋\"）", reason: "缺少商品名", data: {} };
          }
          const products = await callBizApi<Product[]>("/api/products", "GET", token);
          const target = products.find((p) => p.name.includes(product.name!));
          if (!target) {
            return { status: "error", output: `未找到商品「${product.name}」`, reason: "商品不存在", data: {} };
          }
          const updated = await callBizApi<Product>(
            `/api/products/${target.id}`,
            "PATCH",
            token,
            { status: "off_sale" },
          );
          return { status: "success", output: `🛑 已下架「${updated.name}」`, data: { product_id: updated.id } };
        }
        default:
          return { status: "error", output: `未知操作: ${action}`, reason: "未知意图", data: {} };
      }
    } catch (e) {
      logger.warn(`catalog 执行失败: ${String(e)}`);
      return {
        status: "error",
        output: `商品操作失败：${(e as Error).message}`,
        reason: (e as Error).message,
        data: {},
      };
    }
  },
};

export default skill;
