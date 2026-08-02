const test = require("node:test");
const assert = require("node:assert/strict");

const { scrubText, scrubUrl, scrubSentryEvent } = require("../../src/lib/sentryScrubber");

test("scrubUrl masks emails in query params", () => {
  const input = "https://app.example.com/reset?email=john.doe@example.com";
  const output = scrubUrl(input);
  assert.ok(!output.includes("john.doe@example.com"));
  assert.ok(output.includes("email=%5Bredacted-email%5D"));
});

test("scrubUrl masks invoice ids in paths", () => {
  const input = "/api/invoices/INV-2024-001?foo=bar";
  const output = scrubUrl(input);
  assert.ok(output.includes("/api/invoices/[redacted-invoice]"));
  assert.ok(!output.includes("INV-2024-001"));
});

test("scrubUrl masks name-like query params", () => {
  const input = "/app/customers?name=Jane%20Doe&company=ACME";
  const output = scrubUrl(input);
  assert.ok(output.includes("name=%5Bredacted-name%5D"));
  assert.ok(output.includes("company=%5Bredacted-name%5D"));
});

test("scrubSentryEvent removes user PII fields", () => {
  const event = {
    request: { url: "https://example.com/path?email=person@example.com" },
    user: { email: "person@example.com", name: "Person", username: "person", id: "123" },
  };
  const scrubbed = scrubSentryEvent(event);
  assert.ok(scrubbed.request.url.includes("email=%5Bredacted-email%5D"));
  assert.equal(scrubbed.user.email, undefined);
  assert.equal(scrubbed.user.name, undefined);
  assert.equal(scrubbed.user.username, undefined);
  assert.equal(scrubbed.user.id, "123");
});

test("scrubUrl masks public invoice, quote and portal tokens", () => {
  const token = "abcdefghijklmnopqrstuvwxyz" + "123456";

  assert.equal(scrubUrl(`/i/${token}`), "/i/[redacted]");
  assert.equal(scrubUrl(`/q/${token}?download=1`), "/q/[redacted]?download=1");
  assert.equal(scrubUrl(`https://app.example.test/c/${token}`), "https://app.example.test/c/[redacted]");
});

test("scrubUrl keeps short public test tokens", () => {
  assert.equal(scrubUrl("/i/short"), "/i/short");
  assert.equal(scrubUrl("/q/demo-quote"), "/q/demo-quote");
});

test("scrubUrl masks demo invitation bearer tokens in URL fragments", () => {
  const token = "signed.demo.invitation-token";
  const output = scrubUrl(`/app/register#demo_invitation=${token}`);

  assert.ok(!output.includes(token));
  assert.equal(output, "/app/register#demo_invitation=[redacted]");
});

test("scrubText masks public tokens inside free text", () => {
  const token = "abcdefghijklmnopqrstuvwxyz" + "123456";
  const output = scrubText(`Navigation vers https://app.example.test/i/${token}`);
  assert.ok(!output.includes(token));
  assert.ok(output.includes("https://app.example.test/i/[redacted]"));
});

test("scrubSentryEvent masks public tokens in message breadcrumbs exceptions and extra", () => {
  const token = "abcdefghijklmnopqrstuvwxyz" + "123456";
  const event = {
    message: `Erreur sur /i/${token}`,
    request: {
      url: `https://app.example.test/q/${token}?email=person@example.com`,
      headers: { referer: `https://app.example.test/c/${token}` },
    },
    breadcrumbs: [
      {
        message: `Clicked /i/${token}`,
        data: { to: `/q/${token}`, payload: { public_url: `/c/${token}` } },
      },
    ],
    exception: { values: [{ value: `Failed public link /i/${token}` }] },
    extra: { public_url: `https://app.example.test/c/${token}`, email: "person@example.com" },
  };

  const scrubbed = scrubSentryEvent(event);
  const serialized = JSON.stringify(scrubbed);

  assert.ok(!serialized.includes(token));
  assert.ok(!serialized.includes("person@example.com"));
  assert.ok(serialized.includes("/i/[redacted]"));
  assert.ok(serialized.includes("/q/[redacted]"));
  assert.ok(serialized.includes("/c/[redacted]"));
});
