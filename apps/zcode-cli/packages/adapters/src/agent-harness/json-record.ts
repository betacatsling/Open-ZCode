/** CLI 输出是外部数据：只做结构化读取，不信任任何字段的存在或类型。 */
export type JsonRecord = Readonly<Record<string, unknown>>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function readString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readArray(record: JsonRecord | undefined, key: string): readonly unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

export function readRecord(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  return asRecord(record?.[key]);
}

/** 把工具结果（字符串、内容块数组或任意 JSON）压平为可展示文本。 */
export function stringifyToolOutput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const block = asRecord(item);
        const text = readString(block, "text");
        if (text !== undefined) return text;
        return typeof item === "string" ? item : "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  const record = asRecord(value);
  if (record && Array.isArray(record.content)) return stringifyToolOutput(record.content);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
