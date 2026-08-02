const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_TEST_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const INVOICE_PATH_RE = /(\/(?:invoices|invoice|factures|facture)\/)([^/?#]+)/gi;
const PUBLIC_URL_TOKEN_RE = /((?:https?:\/\/[^\s'"<>]+)?\/(?:i|q|c)\/)[A-Za-z0-9_-]{20,}/g;
const PUBLIC_TOKEN_PLACEHOLDER = "[redacted]";

const NAME_KEYS = new Set([
  "name",
  "first_name",
  "last_name",
  "full_name",
  "fullname",
  "company",
  "customer",
  "client",
  "contact",
  "user",
]);

const INVOICE_KEYS = new Set(["invoice", "invoice_id", "invoice_number", "facture", "facture_id", "facture_number"]);
const SECRET_URL_KEYS = new Set(["demo_invitation", "token", "access_token", "refresh_token"]);

const scrubText = (rawText) => {
  if (typeof rawText !== "string") return rawText;
  return rawText
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PUBLIC_URL_TOKEN_RE, `$1${PUBLIC_TOKEN_PLACEHOLDER}`)
    .replace(INVOICE_PATH_RE, "$1[redacted-invoice]");
};

const scrubUrl = (rawUrl) => {
  if (!rawUrl) return rawUrl;
  const input = String(rawUrl);
  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const isSchemeRelative = !hadProtocol && input.startsWith("//");
  const sanitized = scrubText(input);

  try {
    const base = hadProtocol ? undefined : "http://sentry.invalid";
    const url = new URL(sanitized, base);
    let changed = false;
    url.pathname = url.pathname.replace(PUBLIC_URL_TOKEN_RE, `$1${PUBLIC_TOKEN_PLACEHOLDER}`);
    url.pathname = url.pathname.replace(INVOICE_PATH_RE, "$1[redacted-invoice]");
    const params = url.searchParams;
    for (const [key, value] of params.entries()) {
      const lowerKey = String(key || "").toLowerCase();
      const isEmailKey = lowerKey.includes("email");
      const isInvoiceKey = INVOICE_KEYS.has(lowerKey) || lowerKey.includes("invoice") || lowerKey.includes("facture");
      const isNameKey = NAME_KEYS.has(lowerKey) || lowerKey.endsWith("_name") || lowerKey.endsWith("name");
      const isSecretKey = SECRET_URL_KEYS.has(lowerKey) || lowerKey.endsWith("_token");
      if (isSecretKey) {
        params.set(key, PUBLIC_TOKEN_PLACEHOLDER);
        changed = true;
      } else if (isEmailKey || EMAIL_TEST_RE.test(value)) {
        params.set(key, "[redacted-email]");
        changed = true;
      } else if (isInvoiceKey) {
        params.set(key, "[redacted-invoice]");
        changed = true;
      } else if (isNameKey) {
        params.set(key, "[redacted-name]");
        changed = true;
      }
    }
    if (changed) {
      url.search = params.toString() ? `?${params.toString()}` : "";
    }
    if (url.hash.includes("=")) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      let fragmentChanged = false;
      for (const [key] of fragment.entries()) {
        const lowerKey = String(key || "").toLowerCase();
        if (SECRET_URL_KEYS.has(lowerKey) || lowerKey.endsWith("_token")) {
          fragment.set(key, PUBLIC_TOKEN_PLACEHOLDER);
          fragmentChanged = true;
        }
      }
      if (fragmentChanged) {
        url.hash = fragment.toString() ? `#${fragment.toString()}` : "";
      }
    }
    const output = hadProtocol
      ? url.toString()
      : isSchemeRelative
        ? `//${url.host}${url.pathname}${url.search}${url.hash}`
        : `${url.pathname}${url.search}${url.hash}`;
    return output.replace(/%5Bredacted%5D/gi, PUBLIC_TOKEN_PLACEHOLDER);
  } catch (err) {
    return sanitized;
  }
};

const scrubValue = (value, seen = new WeakSet()) => {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    const lowerKey = String(key || "").toLowerCase();
    sanitized[key] =
      lowerKey === "url" ||
      lowerKey === "href" ||
      lowerKey === "path" ||
      lowerKey === "pathname" ||
      lowerKey === "from" ||
      lowerKey === "to" ||
      lowerKey === "transaction"
        ? scrubUrl(item)
        : scrubValue(item, seen);
  }
  return sanitized;
};

const scrubSentryEvent = (event) => {
  if (!event || typeof event !== "object") return event;
  const request = event.request;
  if (request && typeof request === "object") {
    if (request.url) {
      request.url = scrubUrl(request.url);
    }
    if (request.headers && typeof request.headers === "object") {
      const headers = request.headers;
      for (const [key, value] of Object.entries(headers)) {
        headers[key] = scrubValue(value);
      }
      const ref = headers.Referer || headers.referer || headers.Referrer || headers.referrer;
      if (ref) {
        const scrubbed = scrubUrl(ref);
        if (headers.Referer) headers.Referer = scrubbed;
        if (headers.referer) headers.referer = scrubbed;
        if (headers.Referrer) headers.Referrer = scrubbed;
        if (headers.referrer) headers.referrer = scrubbed;
      }
    }
  }
  if (typeof event.transaction === "string") {
    event.transaction = scrubUrl(event.transaction);
  }
  if (typeof event.message === "string") {
    event.message = scrubText(event.message);
  }
  if (event.extra && typeof event.extra === "object") {
    event.extra = scrubValue(event.extra);
  }
  if (event.exception && Array.isArray(event.exception.values)) {
    event.exception.values.forEach((exception) => {
      if (!exception || typeof exception !== "object") return;
      if (typeof exception.value === "string") exception.value = scrubText(exception.value);
      if (exception.stacktrace) exception.stacktrace = scrubValue(exception.stacktrace);
    });
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs.forEach((crumb) => {
      if (!crumb || typeof crumb !== "object") return;
      if (typeof crumb.message === "string") crumb.message = scrubText(crumb.message);
      if (!crumb.data || typeof crumb.data !== "object") return;
      crumb.data = scrubValue(crumb.data);
    });
  }
  if (event.user && typeof event.user === "object") {
    delete event.user.email;
    delete event.user.name;
    delete event.user.username;
    delete event.user.ip_address;
  }
  return event;
};

module.exports = {
  scrubText,
  scrubUrl,
  scrubSentryEvent,
};
