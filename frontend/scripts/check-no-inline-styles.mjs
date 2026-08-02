import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(scriptDir, "..");
const srcDir = path.join(rootDir, "src");

const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "docs", "figma"]);

const RULES = [
  {
    id: "jsx-inline-style",
    label: "JSX inline style",
    regex: /style\s*=\s*\{\{/,
  },
  {
    id: "element-style",
    label: "DOM style API",
    regex: /\.style\./,
  },
  {
    id: "set-attribute-style",
    label: "setAttribute('style')",
    regex: /setAttribute\s*\(\s*['"]style['"]/,
  },
];

function normalizePath(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function shortSnippet(value) {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(fullPath)));
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) files.push(fullPath);
  }

  return files;
}

function stripStringsAndComments(lines) {
  const cleanedLines = [];
  let inBlockComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;

  for (const line of lines) {
    let out = "";
    let i = 0;

    while (i < line.length) {
      const c = line[i];
      const n = line[i + 1];

      if (inBlockComment) {
        if (c === "*" && n === "/") {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (inSingleQuote) {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "'") inSingleQuote = false;
        i += 1;
        continue;
      }

      if (inDoubleQuote) {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === '"') inDoubleQuote = false;
        i += 1;
        continue;
      }

      if (inTemplate) {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "`") inTemplate = false;
        i += 1;
        continue;
      }

      if (c === "/" && n === "/") {
        break;
      }
      if (c === "/" && n === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (c === "'") {
        inSingleQuote = true;
        i += 1;
        continue;
      }
      if (c === '"') {
        inDoubleQuote = true;
        i += 1;
        continue;
      }
      if (c === "`") {
        inTemplate = true;
        i += 1;
        continue;
      }

      out += c;
      i += 1;
    }

    cleanedLines.push(out);
  }

  return cleanedLines;
}

const files = await collectSourceFiles(srcDir);
const violations = [];

for (const filePath of files) {
  const source = await readFile(filePath, "utf8");
  const originalLines = source.split(/\r?\n/);
  const cleanedLines = stripStringsAndComments(originalLines);

  for (let idx = 0; idx < cleanedLines.length; idx += 1) {
    const codeLine = cleanedLines[idx];
    if (!codeLine.trim()) continue;

    for (const rule of RULES) {
      if (!rule.regex.test(codeLine)) continue;
      violations.push({
        file: normalizePath(filePath),
        line: idx + 1,
        label: rule.label,
        snippet: shortSnippet(originalLines[idx]),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`Inline style check failed: ${violations.length} violation(s) found.`);
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.label}] ${violation.snippet}`);
  }
  process.exit(1);
}

console.log(`Inline style check OK: scanned ${files.length} source files, no forbidden inline styles found.`);
