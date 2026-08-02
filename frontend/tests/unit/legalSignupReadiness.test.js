const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const registerPagePath = path.resolve("src/figma/app/pages/auth/RegisterPage.tsx");
const source = fs.readFileSync(registerPagePath, "utf8");

test("public signup fails closed until backend confirms legal readiness", () => {
  assert.match(source, /payload\?\.signupReady === true/);
  assert.match(source, /!signupReady \|\|/);
  assert.match(source, /Les inscriptions sont temporairement indisponibles/);
  assert.match(source, /const signupFormDisabled = legalDocsLoading \|\| !signupReady/);
  assert.ok((source.match(/disabled=\{signupFormDisabled\}/g) || []).length >= 6);
  assert.match(source, /!legalDocsLoading && !signupReady && signupReadinessMessage/);
  assert.match(source, /id="signup-readiness-status"/);
  assert.match(source, /className="auth-register__form space-y-4"/);
});
