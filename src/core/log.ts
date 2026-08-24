/** JSON 日志（） */
export function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const entry = {
    ts: new Date().toISOString().slice(0, 19).replace("T", " "),
    level: level.toUpperCase(),
    logger: "flyer",
    msg,
    ...(extra ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (m: string, e?: Record<string, unknown>) => log("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => log("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => log("error", m, e),
};
