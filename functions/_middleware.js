import {
  createLoginOptions,
  getPasskeys,
  readPasskeyRequest,
  verifyPasskeyLogin
} from "./_shared/passkeys.js";

const SESSION_COOKIE = "church_oceania_cell_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PASSWORD_HASH_KEY = "auth.passwordHash";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const MAX_PBKDF2_ITERATIONS = 100000;
const PUBLIC_AUTH_ASSETS = new Set([
  "/share-card.png",
  "/favicon.svg",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/auth.js"
]);
const PUBLIC_API_PATHS = new Set([
  "/api/webhook/call-note"
]);
const SITE_URL = "https://church-oceania-cell.pages.dev/";
const META_TITLE = "\uC624\uC138\uC544\uB2C8\uC544 \uACF5\uB3D9\uCCB4 \uAD00\uB9AC";
const META_SITE_NAME = "\uC624\uC138\uC544\uB2C8\uC544 \uACF5\uB3D9\uCCB4";
const META_DESCRIPTION = "\uC140\uBCC4 \uC131\uB3C4 \uAD00\uB9AC\uC640 \uC2EC\uBC29 \uAE30\uB85D\uC744 \uC704\uD55C \uACF5\uB3D9\uCCB4 \uAD00\uB9AC \uD398\uC774\uC9C0";
const META_IMAGE = SITE_URL + "share-card.png?v=3";
const LOGIN_NOT_CONFIGURED = "\uB85C\uADF8\uC778 \uC124\uC815\uC774 \uC544\uC9C1 \uBC18\uC601\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694.";
const INVALID_PASSWORD = "\uBE44\uBC00\uBC88\uD638\uAC00 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.";
const LOGIN_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const PASSKEY_PERMISSIONS_POLICY = "publickey-credentials-create=(self), publickey-credentials-get=(self)";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return next();
  if (PUBLIC_AUTH_ASSETS.has(url.pathname)) return next();
  if (PUBLIC_API_PATHS.has(url.pathname)) return next();

  const authConfigured = await isAuthConfigured(env);
  if (!authConfigured) {
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Login is not configured" }, 503);
    }
    return loginPage(LOGIN_NOT_CONFIGURED, 503);
  }

  if (url.pathname === "/__auth/login") {
    return request.method === "POST" ? login(request, env) : loginPage();
  }

  if (url.pathname === "/__auth/passkey/options") {
    return passkeyOptions(request, env);
  }

  if (url.pathname === "/__auth/passkey/login") {
    return passkeyLogin(request, env);
  }

  if (url.pathname === "/__auth/logout") {
    return redirect("/", clearSessionCookie());
  }

  if (await hasValidSession(request, env)) return next();

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Login required" }, 401);
  }

  return loginPage();
}

async function isAuthConfigured(env) {
  const hasPassword = Boolean((await getStoredPasswordHash(env)) || env.SITE_PASSWORD);
  const hasSessionSecret = Boolean(env.SESSION_SECRET || env.SITE_PASSWORD);
  return hasPassword && hasSessionSecret;
}

async function login(request, env) {
  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (!(await verifySitePassword(password, env))) {
    return loginPage(INVALID_PASSWORD, 401);
  }

  return redirect("/", { "Set-Cookie": await createSessionCookie(env) });
}

async function passkeyOptions(request, env) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("check") === "1") {
      return json({ available: (await getPasskeys(env)).length > 0 }, 200, { "Cache-Control": "no-store" });
    }
    return json(await createLoginOptions(request, env), 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return json({ error: error.message || "Passkey options failed" }, error.status || 500, {
      "Cache-Control": "no-store"
    });
  }
}

async function passkeyLogin(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const credential = await readPasskeyRequest(request);
    await verifyPasskeyLogin(request, env, credential);
    return json({ ok: true }, 200, {
      "Cache-Control": "no-store",
      "Set-Cookie": await createSessionCookie(env)
    });
  } catch (error) {
    return json({ error: error.message || "Passkey login failed" }, error.status || 500, {
      "Cache-Control": "no-store"
    });
  }
}

async function createSessionCookie(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAt}`;
  const signature = await sign(payload, env);
  return [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ].join("; ");
}

async function verifySitePassword(password, env) {
  const storedHash = await getStoredPasswordHash(env);
  if (storedHash && await verifyPasswordHash(password, storedHash)) return true;
  return Boolean(env.SITE_PASSWORD) && password === env.SITE_PASSWORD;
}

async function getStoredPasswordHash(env) {
  if (!env.DB) return "";
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(PASSWORD_HASH_KEY)
      .first();
    return typeof row?.value === "string" ? row.value : "";
  } catch {
    return "";
  }
}

async function verifyPasswordHash(password, storedHash) {
  const [algorithm, iterationsText, saltText, expectedText] = String(storedHash || "").split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== PASSWORD_ALGORITHM || !Number.isFinite(iterations) || !saltText || !expectedText) {
    return false;
  }
  if (iterations > MAX_PBKDF2_ITERATIONS) return false;

  try {
    const salt = base64UrlToBytes(saltText);
    const expected = base64UrlToBytes(expectedText);
    const actual = new Uint8Array(await derivePasswordBits(password, salt, iterations));
    return timingSafeBytesEqual(actual, expected);
  } catch {
    return false;
  }
}

async function derivePasswordBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
}

async function hasValidSession(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const value = cookies[SESSION_COOKIE];
  if (!value) return false;

  const [expiresAt, signature] = value.split(".");
  if (!expiresAt || !signature) return false;
  if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;

  const expected = await sign(expiresAt, env);
  return timingSafeEqual(signature, expected);
}

async function sign(payload, env) {
  const secret = env.SESSION_SECRET || env.SITE_PASSWORD;
  if (!secret) throw new Error("Session secret is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(signature);
}

function loginPage(error = "", status = 200) {
  const errorMarkup = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return new Response(
    `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>공동체관리 \uB85C\uADF8\uC778</title>
    ${metaTags()}
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f7f4ed;
        color: #221f1a;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(420px, calc(100vw - 32px));
        padding: 34px;
        border: 1px solid #dacdb8;
        border-radius: 8px;
        background: #fffdf8;
        box-shadow: 0 20px 60px rgba(64, 52, 34, 0.12);
      }
      .eyebrow {
        margin: 0 0 8px;
        color: #b43a2a;
        font-size: 14px;
        font-weight: 700;
      }
      h1 {
        margin: 0 0 26px;
        font-size: 34px;
        line-height: 1.1;
      }
      label {
        display: grid;
        gap: 8px;
        color: #6d6255;
        font-size: 14px;
        font-weight: 700;
      }
      input {
        box-sizing: border-box;
        width: 100%;
        height: 48px;
        border: 1px solid #d8c9b4;
        border-radius: 8px;
        padding: 0 14px;
        font: inherit;
        color: #221f1a;
        background: #fff;
      }
      button {
        width: 100%;
        height: 50px;
        margin-top: 18px;
        border: 0;
        border-radius: 8px;
        background: #23746b;
        color: #fff;
        font-size: 17px;
        font-weight: 800;
        cursor: pointer;
      }
      button:disabled { opacity: 0.6; cursor: wait; }
      .passkey-area {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid #e4d9ca;
      }
      .passkey-button {
        margin-top: 0;
        border: 1px solid #23746b;
        background: #fff;
        color: #1d625b;
      }
      .passkey-status {
        min-height: 20px;
        margin: 10px 0 0;
        color: #6d6255;
        font-size: 13px;
        line-height: 1.45;
      }
      .error {
        margin: 0 0 14px;
        color: #b42318;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">\uC624\uC138\uC544\uB2C8\uC544 \uACF5\uB3D9\uCCB4</p>
      <h1>공동체관리</h1>
      ${errorMarkup}
      <form method="post" action="/__auth/login">
        <label>
          \uAD00\uB9AC\uC790 \uBE44\uBC00\uBC88\uD638
          <input name="password" type="password" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">\uB85C\uADF8\uC778</button>
      </form>
      <div class="passkey-area" id="passkeyArea" hidden>
        <button class="passkey-button" id="passkeyLoginBtn" type="button">\uC0DD\uCCB4 \uC778\uC99D/\uD328\uC2A4\uD0A4\uB85C \uB85C\uADF8\uC778</button>
        <p class="passkey-status" id="passkeyStatus" role="status"></p>
      </div>
    </main>
    <script src="/auth.js" defer></script>
  </body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": LOGIN_CSP,
        "Permissions-Policy": PASSKEY_PERMISSIONS_POLICY,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin"
      }
    }
  );
}

function metaTags() {
  return `<meta name="description" content="${META_DESCRIPTION}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${META_SITE_NAME}">
    <meta property="og:title" content="${META_TITLE}">
    <meta property="og:description" content="${META_DESCRIPTION}">
    <meta property="og:url" content="${SITE_URL}">
    <meta property="og:image" content="${META_IMAGE}">
    <meta property="og:image:secure_url" content="${META_IMAGE}">
    <meta property="og:image:alt" content="${META_TITLE}">
    <meta property="og:locale" content="ko_KR">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${META_TITLE}">
    <meta name="twitter:description" content="${META_DESCRIPTION}">
    <meta name="twitter:image" content="${META_IMAGE}">
    <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml">
    <link rel="icon" href="/favicon.png?v=2" type="image/png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2">`;
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: { ...headers, Location: location }
  });
}

function clearSessionCookie() {
  return {
    "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  };
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
      })
  );
}

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

function timingSafeBytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a[index] ^ b[index];
  }
  return result === 0;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}
