/**
 * catalog 技能：商家商品管理（上架/查询/改价/下架）
 *
 * 对接业务系统商品 API：X-Biz-Key（服务间鉴权）+ 透传用户 JWT（身份验证）。
 * 领域执行（业务 API 调用）在本技能；harness 负责路由/鉴权/反馈。
 */
import { config } from "../../core/config.js";
import { logger } from "../../core/log.js";
import type { GenericState, IntentResult, Skill, SkillManifest, SkillResult } from "../../types/index.js";

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
  intents: ["new_request", "catalog_add", "catalog_query", "catalog_update", "catalog_off"],
  intent_descriptions: {
    catalog_add: "上架商品（用户说上架X时用；含创建或恢复）",
    catalog_query: "查询/查看商品信息（用户说'给我X信息''查X''看X''X的价格库存状态'时用——只读不改）",
    catalog_update: "修改/调整商品价格或库存（用户明确说改/调/修改时才用；仅查信息不是修改）",
    catalog_off: "下架商品（用户说下架/删除X时用）",
  },
  cacheable_intents: ["catalog_query"],  // 写操作（上架/改/下架）不缓存
  trigger_keywords: ["上架", "商品", "下架", "改价", "库存", "价格", "信息", "详情", "查询", "查看", "给我", "名称", "改名", "修改", "调整"],
  session_mode: "single",
  max_turns_per_session: 1,
  max_llm_calls_per_turn: 2,
  data_scopes: ["shop"],
};

/** 解析商品字段（按操作类型限定，避免误抓）
 * - off（下架）：只解析名称，剔除操作词
 * - add（上架）：名称 + 价格（需货币词）+ 库存
 * - update（改）：名称 + 价格/库存（价格需"价格/改为/元"等确认，防裸数字误抓）
 * - query（查询）：不解析
 */
function parseProduct(text: string, action: string): { name?: string; new_name?: string; price?: number; stock?: number } {
  const out: { name?: string; new_name?: string; price?: number; stock?: number } = {};
  // 引号包裹的名称（最明确）；清洗引号字符
  const quoted = text.match(/["'「」《](.+?)["'」》]/);
  if (quoted) {
    out.name = quoted[1].trim();
  } else if (action !== "query") {
    // 无引号：剔除操作指令词，取剩余部分的首个连续词作为名称
    const ops = action === "off"
      ? ["下架", "删除", "停用", "移除", "帮我", "请帮我", "把", "将", "的", "状态"]
      : action === "update"
        ? ["价格", "库存", "数量", "改为", "改成", "调成", "设为", "为", "到", "帮我", "请帮我", "把", "将", "的"]
        : action === "query"
          ? ["所有", "全部", "信息", "价格", "库存", "数量", "状态", "的", "给我", "查", "看", "资料", "详情"]
          : ["上架", "库存", "价格", "元", "块", "帮我", "请帮我", "把", "将", "的"];
    let cleaned = text;
    for (const op of ops) cleaned = cleaned.split(op).join(" ");
    const firstWord = cleaned.match(/[\u4e00-\u9fa5A-Za-z0-9]+/);
    out.name = (firstWord?.[0] ?? "").trim() || undefined;
  }
  if (action === "update" || action === "add") {
    // 价格：仅价格专属词确认（价格/单价/售价/定价/元/块），
    // 不用通用"改为/为"——否则"库存改成77"的 77 会被误当价格
    const priceMatch = text.match(
      /(?:价格|单价|售价|定价)(?:改为|改成|调成|设为|调整为|为|到)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/,
    ) ?? text.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/);
    if (priceMatch) out.price = Number(priceMatch[1]);
    // 库存：仅"库存/数量"词确认
    const stockMatch = text.match(/(?:库存|数量)(?:\s*|改成|改为|调成|设为|变成|调整为|为|到)\s*(\d+)/);
    if (stockMatch) out.stock = Number(stockMatch[1]);
  }
  // 改名目标："X名称改为Y" / "X改名为Y" / "重命名X为Y" → Y（引号或自然文本）
  const renameMatch = text.match(/(?:名称|名字|改名|重命名)(?:改为|改成|为|成|叫)?\s*["'「」《]?([^"'「」》\s，。,]+)["'「」》]?/);
  if (renameMatch && action === "update") out.new_name = renameMatch[1].trim();
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
      // 动作解析：显式意图优先；new_request（规则兜底）按文本猜测
      let action = intent.intent.replace("catalog_", "");
      if (action === "new_request") {
        if (newText.includes("上架")) action = "add";
        else if (newText.includes("下架")) action = "off";
        else if (newText.includes("改") || newText.includes("价格")) action = "update";
        else if (newText.includes("查") || newText.includes("看")) action = "query";
        else action = "add";
      }
      // 字段来源：LLM params 优先（语义抽取），正则 parseProduct 兜底（无 LLM/漏抽时）
      const regex = parseProduct(newText, action);
      const p = intent.params ?? {};
      const product = {
        name: (p.name as string | undefined) ?? regex.name,
        new_name: (p.new_name as string | undefined) ?? regex.new_name,
        price: (p.price as number | undefined) ?? regex.price,
        stock: (p.stock as number | undefined) ?? regex.stock,
      };

      switch (action) {
        case "add": {
          if (!product.name) {
            return {
              status: "error",
              output: "上架需要商品名（如：上架\"Nike 鞋\" 299元 库存50）",
              reason: "缺少商品名",
              data: {},
            };
          }
          // 上架语义：同名商品已存在（如之前下架的）→ 恢复上架状态；不存在 → 创建新商品
          const existing = await callBizApi<Product[]>("/api/products", "GET", token);
          const target = existing.find((p) => p.name === product.name);
          if (target) {
            const restored = await callBizApi<Product>(
              `/api/products/${target.id}`,
              "PATCH",
              token,
              { status: "on_sale", ...(product.price ? { price: product.price } : {}), ...(product.stock !== undefined ? { stock: product.stock } : {}) },
            );
            return {
              status: "success",
              output: `✅ 已上架商品：${restored.name}（${restored.price}元，库存${restored.stock}，id=${restored.id}）`,
              data: { product_id: restored.id },
            };
          }
          if (!product.price) {
            return {
              status: "error",
              output: "新商品上架需要价格（如：上架\"Nike 鞋\" 299元 库存50）",
              reason: "缺少商品价格",
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
          // 指定了商品名 → 查单个商品；否则查全部
          if (product.name) {
            const target = products.find((p) => p.name === product.name)
              ?? products.find((p) => p.name.includes(product.name!));
            if (!target) {
              return { status: "error", output: `未找到商品「${product.name}」`, reason: "商品不存在", data: {} };
            }
            return {
              status: "success",
              output: `📦 ${target.name}：${target.price}元，库存${target.stock}，状态${target.status}（id=${target.id}）`,
              data: { product_id: target.id },
            };
          }
          const lines = products.map(
            (p) => `${p.name}（${p.price}元，库存${p.stock}，${p.status}）`,
          );
          return { status: "success", output: `📦 商品列表：\n${lines.join("\n")}`, data: { count: products.length } };
        }
        case "update": {
          // 支持改名/改价/改库存任意组合；至少有一个更新目标才执行
          const hasUpdate = product.new_name !== undefined || product.price !== undefined || product.stock !== undefined;
          if (!product.name || !hasUpdate) {
            return {
              status: "error",
              output: "修改需要指定商品名和要改的内容（如：改\"Nike 鞋\"价格 259元 / 名称改为X / 库存改N）",
              reason: "缺少商品名或更新内容",
              data: {},
            };
          }
          const products = await callBizApi<Product[]>("/api/products", "GET", token);
          // 名称精确匹配优先，退而求其次 includes（避免"调试鞋"误匹配"调试鞋2"）
          const target = products.find((p) => p.name === product.name)
            ?? products.find((p) => p.name.includes(product.name!));
          if (!target) {
            return { status: "error", output: `未找到商品「${product.name}」`, reason: "商品不存在", data: {} };
          }
          // 部分更新：只传用户指定的字段（改名/改价/改库存任意组合）
          const patch: Record<string, unknown> = { status: "on_sale" };
          if (product.new_name !== undefined) patch.name = product.new_name;
          if (product.price !== undefined) patch.price = product.price;
          if (product.stock !== undefined) patch.stock = product.stock;
          const updated = await callBizApi<Product>(
            `/api/products/${target.id}`,
            "PATCH",
            token,
            patch,
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
  /** P2 结果验证：上架/改价/下架后回读业务系统确认落库（执行后自证） */
  async verify(state: GenericState, result: SkillResult, newText: string): Promise<boolean> {
    // 查询类无需验证（只读）；验证写操作是否真实生效
    if (!result.data?.product_id) return true;
    const token = state.user_ctx?.token;
    if (!token) return false;
    try {
      const p = await callBizApi<Product>(
        `/api/products/${result.data.product_id}`,
        "GET",
        token,
      );
      // 回读确认：商品存在 + 关键字段与写入一致（上架=存在；改价=价格一致；下架=状态 off_sale）
      if (newText.includes("下架")) return p.status === "off_sale";
      if (newText.includes("改") || newText.includes("价格")) {
        const price = newText.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/);
        return price ? Math.abs(p.price - Number(price[1])) < 0.01 : true;
      }
      return p.id === Number(result.data.product_id);
    } catch (e) {
      logger.warn(`catalog 回读验证失败: ${String(e)}`);
      return false;
    }
  },
};

export default skill;
