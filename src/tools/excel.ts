/** 通用工具层：Excel/CSV 解析（技能可复用的能力单元，与业务无关）
 *
 * 支持两种入口：
 * - parseExcelFile(buffer)：xlsx/xls 文件二进制 → 结构化行
 * - parseCsvText(text)：CSV/表格文本（对话粘贴）→ 结构化行
 *
 * 两者都自动定位表头行：跳过标题行/合并单元格（如第一行"表格 1"、
 * 表头在第二行），找到真正含业务表头的行（≥2 个非空单元格或含表头词）。
 *
 * 输出统一为 { headers: string[], rows: Record<string, string>[] }——
 * 技能（如 catalog 批量上架）自行映射列名到业务字段。
 */
import * as XLSX from "xlsx";

export interface ParsedTable {
  headers: string[];                     // 表头（自动定位的业务表头行）
  rows: Array<Record<string, string>>;   // 数据行（列名 → 单元格字符串）
}

/** 解析 Excel 文件二进制（xlsx/xls）→ 第一个 sheet 的结构化行 */
export function parseExcelFile(buffer: ArrayBuffer | Buffer): ParsedTable {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" }) as unknown[][];
  return matrixToTable(matrix);
}

/** 解析 CSV/表格文本（对话粘贴）→ 结构化行 */
export function parseCsvText(text: string): ParsedTable {
  const wb = XLSX.read(text, { type: "string" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" }) as unknown[][];
  return matrixToTable(matrix);
}

/** 常见表头词：命中即视为业务表头行（防止单列标题行被跳过） */
const HEADER_WORDS = /名称|商品|价格|单价|售价|定价|库存|数量|金额|总价|状态|序号|备注/;

/** 定位表头行：第一个 ≥2 个非空单元格的行，或含常见表头词的行 */
function findHeaderRow(matrix: unknown[][]): number {
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const nonEmpty = row.filter((c) => String(c ?? "").trim() !== "").length;
    if (nonEmpty >= 2 || HEADER_WORDS.test(row.join(" "))) return i;
  }
  return -1;
}

/** 二维数组 → 结构化表（定位表头行，跳过标题/合并单元格结构） */
function matrixToTable(matrix: unknown[][]): ParsedTable {
  const headerIdx = findHeaderRow(matrix);
  if (headerIdx === -1) return { headers: [], rows: [] };
  const headers = (matrix[headerIdx] ?? []).map((c) => String(c ?? "").trim());
  const dataRows = matrix
    .slice(headerIdx + 1)
    .filter((r) => (r ?? []).some((c) => String(c ?? "").trim() !== ""));
  const rows = dataRows.map((r) => {
    const out: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) out[h] = String(r[i] ?? "").trim();
    });
    return out;
  });
  return { headers, rows };
}
