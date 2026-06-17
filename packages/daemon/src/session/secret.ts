import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export function loadOrCreateSecret(path: string): Buffer {
  if (existsSync(path)) {
    return readFileSync(path);
  }
  mkdirSync(dirname(path), { recursive: true });
  const buf = randomBytes(32);
  writeFileSync(path, buf, { mode: 0o600 });
  chmodSync(path, 0o600);
  return buf;
}
