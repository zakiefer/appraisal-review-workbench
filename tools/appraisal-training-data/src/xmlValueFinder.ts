export type XmlNode = unknown;

export function stripNamespace(tagName: string): string {
  const withoutPrefix = tagName.includes(":") ? tagName.split(":").pop() ?? tagName : tagName;
  return withoutPrefix.replace(/^@_?/, "");
}

export function normalizeKey(tagName: string): string {
  return stripNamespace(tagName).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function stripNamespacesDeep(value: XmlNode): XmlNode {
  if (Array.isArray(value)) {
    return value.map(stripNamespacesDeep);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, XmlNode> = {};
  for (const [key, child] of Object.entries(value)) {
    output[stripNamespace(key)] = stripNamespacesDeep(child);
  }
  return output;
}

export function textValue(value: XmlNode): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textValue(item);
      if (text) return text;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, XmlNode>;
    for (const preferred of ["#text", "_text", "text", "Value", "value"]) {
      const text = textValue(record[preferred]);
      if (text) return text;
    }
    const scalarChildren = Object.entries(record).filter(([, child]) => {
      return ["string", "number", "boolean"].includes(typeof child);
    });
    if (scalarChildren.length === 1) {
      return textValue(scalarChildren[0]?.[1]);
    }
  }
  return null;
}

export function getByPath(root: XmlNode, pathParts: string[]): XmlNode | null {
  let current: XmlNode = root;
  for (const pathPart of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const record = current as Record<string, XmlNode>;
    const match = Object.entries(record).find(([key]) => normalizeKey(key) === normalizeKey(pathPart));
    if (!match) return null;
    current = match[1];
  }
  return current ?? null;
}

export function findFirstByPaths(root: XmlNode, paths: string[][]): string | null {
  for (const pathParts of paths) {
    const node = getByPath(root, pathParts);
    const text = textValue(node);
    if (text) return text;
  }
  return null;
}

export function findFirstByAliases(root: XmlNode, aliases: string[]): string | null {
  const normalizedAliases = new Set(aliases.map(normalizeKey));
  const queue: XmlNode[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (normalizedAliases.has(normalizeKey(key))) {
        const text = textValue(child);
        if (text) return text;
      }
      if (child && typeof child === "object") queue.push(child);
    }
  }

  return null;
}

export function findNodesByAliases(root: XmlNode, aliases: string[]): XmlNode[] {
  const normalizedAliases = new Set(aliases.map(normalizeKey));
  const nodes: XmlNode[] = [];
  const queue: XmlNode[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (normalizedAliases.has(normalizeKey(key))) {
        nodes.push(...toArray(child));
      }
      if (child && typeof child === "object") queue.push(child);
    }
  }

  return nodes;
}

export function findFirstNodeByAliases(root: XmlNode, aliases: string[]): XmlNode | null {
  return findNodesByAliases(root, aliases)[0] ?? null;
}

export function countMeaningfulValues(value: object): number {
  return Object.values(value).filter((item) => item !== null && item !== undefined && item !== "").length;
}

export function normalizeNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const raw = typeof value === "number" ? String(value) : value;
  const cleaned = raw.replace(/[$,%]/g, "").replace(/,/g, "").trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCurrency(value: string | number | null | undefined): number | null {
  return normalizeNumber(value);
}

export function normalizeSquareFeet(value: string | number | null | undefined): number | null {
  return normalizeNumber(value);
}

export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, year, month, day] = iso;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const [, month, day, yearRaw] = slash;
    const yearNumber = Number(yearRaw);
    const year = yearRaw.length === 2 ? String(yearNumber >= 70 ? 1900 + yearNumber : 2000 + yearNumber) : yearRaw;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const [, year, month, day] = compact;
    return `${year}-${month}-${day}`;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return trimmed;
  return new Date(parsed).toISOString().slice(0, 10);
}
