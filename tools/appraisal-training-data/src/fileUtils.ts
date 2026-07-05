import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableCaseId(sourcePath: string): string {
  return `case_${sha256(path.resolve(sourcePath)).slice(0, 16)}`;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function findXmlFiles(inputFolder: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) {
        files.push(entryPath);
      } else if (entry.isSymbolicLink() && entry.name.toLowerCase().endsWith(".xml")) {
        const linkedInfo = await stat(entryPath);
        if (linkedInfo.isFile()) {
          files.push(entryPath);
        }
      }
    }
  }

  await walk(inputFolder);
  return files.sort((a, b) => a.localeCompare(b));
}

export async function assertReadableDirectory(inputFolder: string): Promise<void> {
  const info = await stat(inputFolder);
  if (!info.isDirectory()) {
    throw new Error(`Input path is not a directory: ${inputFolder}`);
  }
}

export async function assertWritableOutput(outputFolder: string): Promise<void> {
  await ensureDir(outputFolder);
  const probePath = path.join(outputFolder, `.write-probe-${Date.now()}`);
  await writeFile(probePath, "ok", "utf8");
  await import("node:fs/promises").then((fs) => fs.unlink(probePath));
}

export function safeBasename(filePath: string): string {
  return path.basename(filePath);
}
