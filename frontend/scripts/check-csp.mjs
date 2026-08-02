import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const middlewarePath = path.join(rootDir, '..', 'middleware.ts')

const content = await readFile(middlewarePath, 'utf8')

const lines = content.split(/\r?\n/)
const unsafeInlineLines = lines.filter((line) => line.includes('unsafe-inline'))
const hasScriptUnsafeInline = unsafeInlineLines.some(
  (line) =>
    (line.includes('script-src ') || line.includes('script-src-attr')) &&
    !line.includes('script-src-elem')
)

if (hasScriptUnsafeInline) {
  console.error('CSP check failed: unsafe-inline is present in script-src or script-src-attr (frontend/middleware.ts).')
  process.exit(1)
}

const hasUnsafeInline = unsafeInlineLines.length > 0
if (!hasUnsafeInline) {
  console.log('CSP check OK: no unsafe-inline found in frontend/middleware.ts.')
  process.exit(0)
}

const hasStyleUnsafeInline = unsafeInlineLines.every(
  (line) => line.includes('style-src') || line.includes('style-src-attr') || line.includes('script-src-elem')
)

if (!hasStyleUnsafeInline) {
  console.error('CSP check failed: unsafe-inline appears outside allowed directives (frontend/middleware.ts).')
  process.exit(1)
}

const hasStaticNextJustification = content.includes('STATIC_NEXT_INLINE_SCRIPTS')
const hasScriptElemUnsafeInline = unsafeInlineLines.some((line) => line.includes('script-src-elem'))

if (hasScriptElemUnsafeInline && !hasStaticNextJustification) {
  console.error('CSP check failed: script-src-elem unsafe-inline must document the static Next.js reason.')
  process.exit(1)
}

console.log('CSP check OK: unsafe-inline is absent from script-src/script-src-attr; the documented Next static script-src-elem exception remains isolated.')
