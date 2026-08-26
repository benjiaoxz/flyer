/** 通用工具层：Excel/CSV 解析（技能可复用的能力单元，与业务无关）
 *
 * 支持两种入口：
 * - parseExcelFile(buffer)：xlsx/xls 文件二进制 → 结构化行（exceljs，无 xlsx 高危漏洞）
 * - parseCsvText(text)：CSV/表格文本（对话粘贴）→ 结构化行（自写解析器，零依赖）
 *
 * 两者都自动定位表头行：跳过标题行/合并单元格（如第一行"表格 1"、
 * 表头在第二行），找到真正含业务表头的行（≥2 个非空单元格或含表头词）。
 *
 * 输出统一为 { headers: string[], rows: Record<string, string>[] }——
 * 技能（如 catalog 批量上架）自行映射列名到业务字段。
 */
import ExcelJS from "exceljs";

export interface ParsedTable {
  headers: string[];                     // 表头（自动定位的业务表头行）
  rows: Array<Record<string, string>>;   // 数据行（列名 → 单元格字符串）
}

/** 解析 Excel 文件二进制（xlsx/xls）→ 第一个 sheet 的结构化行 */
export async function parseExcelFile(buffer: ArrayBuffer | Buffer): Promise<ParsedTable> {
  const wb = new ExcelJS.Workbook();
  // 类型对齐 exceljs load 的精确签名（兼容新版 @types/node 的 Buffer 泛型）
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  const matrix: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    // row.values 为 1-indexed 数组（index 0 是行号），切片去掉
    const values = (row.values as unknown[]).slice(1);
    // 合并单元格：exceljs 会把 master 值复制到整个区域（如标题行"表格 1"×N），
    // 非主单元格置空，避免标题行被误判为表头
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
        values[colNumber - 1] = "";
      }
    });
    matrix.push(values);
  });
  return matrixToTable(matrix);
}

/** 解析 CSV/表格文本（对话粘贴）→ 结构化行（自写解析器：逗号分隔 + 引号转义 + 换行） */
export function parseCsvText(text: string): ParsedTable {
  return matrixToTable(csvToMatrix(text));
}

/** 标准 CSV → 二维数组（处理引号包裹字段、"" 转义、\r\n） */
function csvToMatrix(text: string): unknown[][] {
  const rows: unknown[][] = [];
  let row: unknown[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => String(c).trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => String(c).trim() !== "")) rows.push(row);
  return rows;
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
