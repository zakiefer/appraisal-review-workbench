import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { DetectedXmlType } from "./types.js";
import { stripNamespacesDeep, type XmlNode, normalizeKey } from "./xmlValueFinder.js";

export interface ParsedXmlDocument {
  root: XmlNode;
  rawRootName: string | null;
  detectedXmlType: DetectedXmlType;
  parserNotes: string[];
}

export function parseXml(xmlContent: string): ParsedXmlDocument {
  const validation = XMLValidator.validate(xmlContent);
  if (validation !== true) {
    const message =
      typeof validation === "object" && validation.err
        ? `${validation.err.msg} at line ${validation.err.line}, column ${validation.err.col}`
        : "Malformed XML";
    throw new Error(message);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    alwaysCreateTextNode: false,
    isArray: (name) => {
      const normalized = normalizeKey(name);
      return ["comparablesale", "comparable", "comp", "salecomparable", "adjustment", "adjustmentline"].includes(
        normalized
      );
    }
  });

  const parsed = parser.parse(xmlContent) as XmlNode;
  const root = stripNamespacesDeep(parsed);
  const rawRootName = getRootName(parsed);
  const detectedXmlType = detectXmlType(xmlContent, root, rawRootName);
  const parserNotes: string[] = [];

  if (detectedXmlType === "unknown_xml") {
    parserNotes.push("unknown_xml_format");
  }

  return {
    root,
    rawRootName,
    detectedXmlType,
    parserNotes
  };
}

export function detectXmlType(xmlContent: string, root: XmlNode, rawRootName: string | null): DetectedXmlType {
  const lowerXml = xmlContent.slice(0, 5000).toLowerCase();
  const allKeys = collectKeys(root).map(normalizeKey);
  const keySet = new Set(allKeys);
  const rootKey = rawRootName ? normalizeKey(rawRootName) : "";

  if (
    lowerXml.includes("uniform appraisal dataset") ||
    keySet.has("uad") ||
    keySet.has("uniformappraisaldataset") ||
    keySet.has("uadreport")
  ) {
    return "uad_like";
  }

  if (lowerXml.includes("mismo") || rootKey.includes("mismo") || keySet.has("dealsets") || keySet.has("valuation")) {
    return "mismo_like";
  }

  const appraisalSignalCount = [
    "appraisal",
    "appraisalreport",
    "subjectproperty",
    "propertysubject",
    "comparablesale",
    "comparable",
    "comp",
    "reconciliation",
    "valueconclusion",
    "finalopinionofvalue"
  ].filter((signal) => rootKey.includes(signal) || keySet.has(signal)).length;

  if (appraisalSignalCount >= 2) {
    return "generic_appraisal_xml";
  }

  return "unknown_xml";
}

function getRootName(parsed: XmlNode): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed as Record<string, XmlNode>);
  return keys[0] ?? null;
}

function collectKeys(root: XmlNode): string[] {
  const keys: string[] = [];
  const queue: XmlNode[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      keys.push(key);
      if (child && typeof child === "object") queue.push(child);
    }
  }

  return keys;
}
