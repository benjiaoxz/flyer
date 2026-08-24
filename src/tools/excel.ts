/** 通用工具层：Excel/CSV 解析（技能可复用的能力单元，与业务无关）
 *
 * 支持两种入口：
 * - parseExcelFile(buffer)：xlsx/xls 文件二进制 → 结构化行
 * - parseCsvText(text)：CSV/表格文本（对话粘贴）→ 结构化行
 *
 * 输出统一为 { headers: string[], rows: Record<string, string>[] }——
 * 技能（如 catalog 批量上架）自行映射列名到业务字段。
 */
import * as XLSX from "xlsx";

export interface ParsedTable {
  headers: string[];                     // 表头（首行）
  rows: Array<Record<string, string>>;   // 数据行（列名 → 单元格字符串）
}

/** 解析 Excel 文件二进制（xlsx/xls）→ 第一个 sheet 的结构化行 */
export function parseExcelFile(buffer: ArrayBuffer | Buffer): ParsedTable {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return normalizeRows(rows);
}

/** 解析 CSV/表格文本（对话粘贴）→ 结构化行
 * 自动定位表头：跳过前缀自然语言（如"批量上架："），
 * 找到第一个含分隔符（逗号/制表符/多空格）的行作为表头。
 */
export function parseCsvText(text: string): ParsedTable {
  // 定位表格起点：第一个含逗号/制表符的行（表头）
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/[,\t]/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const table = start === -1 ? text : lines.slice(start).join("\n");
  const wb = XLSX.read(table, { type: "string" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return normalizeRows(rows);
}

function normalizeRows(rows: Array<Record<string, unknown>>): ParsedTable {
  if (!rows.length) return { headers: [], rows: [] };
  const headers = Object.keys(rows[0]);
  const normalized = rows.map((r) => {
    const out: Record<string, string> = {};
    for (const h of headers) out[h] = String(r[h] ?? "").trim();
    return out;
  });
  return { headers, rows: normalized };
}
