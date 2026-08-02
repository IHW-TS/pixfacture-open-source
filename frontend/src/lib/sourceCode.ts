const DEFAULT_SOURCE_CODE_URL = "https://github.com/IHW-TS/pixfacture-open-source";

export function getSourceCodeUrl(): string {
  return (process.env.NEXT_PUBLIC_SOURCE_CODE_URL || "").trim() || DEFAULT_SOURCE_CODE_URL;
}
