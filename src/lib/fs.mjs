import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "a"
  });
}

export async function removePath(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

export async function listFilesRecursive(rootDir, { ignoreDirNames = [] } = {}) {
  const files = [];
  if (!(await pathExists(rootDir))) {
    return files;
  }
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoreDirNames.includes(entry.name)) {
        continue;
      }
      files.push(...(await listFilesRecursive(fullPath, { ignoreDirNames })));
      continue;
    }
    files.push(fullPath);
  }
  return files.sort();
}

export function toPosixRelative(basePath, targetPath) {
  return path.relative(basePath, targetPath).split(path.sep).join(path.posix.sep);
}

export function relativeIsInside(baseRelative, childRelative) {
  return (
    childRelative === baseRelative ||
    childRelative.startsWith(`${baseRelative}/`) ||
    baseRelative === "."
  );
}
