import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
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

export async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

export async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "a"
  });
}

// `maxRetries` covers the case that matters here: a detached provider child that
// outlives its kill can recreate a capture file between unlink and rmdir, which
// surfaces as ENOTEMPTY and would otherwise strand the directory. Node retries
// ENOTEMPTY/EBUSY/EPERM internally with the given backoff.
export async function removePath(targetPath) {
  await rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// Creates a temp directory under os.tmpdir() with the given prefix, runs
// fn(dir), and always removes the directory afterward - even if fn throws.
// The original error (if any) propagates unchanged; cleanup failures are
// swallowed so they never mask it or fail an otherwise-successful call.
export async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await removePath(dir).catch(() => {});
  }
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
