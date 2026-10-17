import { createHash } from "node:crypto";

/** The database drivers encode text as UTF-8, replacing unpaired surrogates. */
export function persistedText(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

export function bodyVersion(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
