const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "../..")

const activeSources = [
  "src/app",
  "src/components",
  "src/data",
  "src/lib",
  "src/figma/app",
  "figma-compare-srcs",
]

const bannedClaims = [
  /Facturation \+ PA/u,
  /DGFiP · PA/u,
  /Factur.?X · PA · DGFiP/u,
  /Factur.?X · Chorus · DGFiP/u,
  /Réforme 2026.*DGFiP/u,
  /Factur.?X si conforme/u,
  /E-facturation active/u,
  /Accès Chorus/u,
  /Accès Seqino/u,
  /2027 : prêt/u,
  /Archivage probant/u,
  /Object Lock actif/u,
  /Volume illimité/u,
  /Le plus choisi/u,
  /2 mois off/u,
  /Conforme aux exigences de l'article 28/u,
  /conforme art\. 28/u,
  /Tous disponibles et versionnés/u,
  /Validation passée/u,
  /Disponibilité SaaS/u,
  /Objectif 2j/u,
]

const textExtensions = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".mjs",
])

function walk(dir) {
  const entries = []
  if (!fs.existsSync(dir)) return entries
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "imports" && dir.endsWith(path.join("src", "figma"))) continue
    if (entry.name === "node_modules" || entry.name === ".next") continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      entries.push(...walk(fullPath))
    } else if (textExtensions.has(path.extname(entry.name))) {
      entries.push(fullPath)
    }
  }
  return entries
}

test("active marketing sources avoid over-claiming e-invoicing readiness", () => {
  const hits = []
  for (const relativeDir of activeSources) {
    for (const file of walk(path.join(root, relativeDir))) {
      const text = fs.readFileSync(file, "utf8")
      for (const pattern of bannedClaims) {
        if (pattern.test(text)) {
          hits.push(`${path.relative(root, file)}: ${pattern}`)
        }
      }
    }
  }
  assert.deepEqual(hits, [])
})
