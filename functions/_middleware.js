const SESSION_COOKIE = "seosanch_cell_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PUBLIC_AUTH_ASSETS = new Set([
  "/share-card.png",
  "/favicon.svg",
  "/favicon.png",
  "/apple-touch-icon.png"
]);
const SITE_URL = "https://seosanch-cell.pages.dev/";
const META_TITLE = "\uB0A8\uC544\uBA54\uB9AC\uCE74 \uACF5\uB3D9\uCCB4 \uAD50\uAD6C\uAD00\uB9AC";
const META_SITE_NAME = "\uB0A8\uC544\uBA54\uB9AC\uCE74 \uACF5\uB3D9\uCCB4";
const META_DESCRIPTION = "\uC140\uBCC4 \uC131\uB3C4 \uAD00\uB9AC\uC640 \uC2EC\uBC29 \uAE30\uB85D\uC744 \uC704\uD55C \uAD00\uB9AC\uC790 \uD398\uC774\uC9C0";
const META_IMAGE = SITE_URL + "share-card.png?v=1";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return next();
  if (PUBLIC_AUTH_ASSETS.has(url.pathname)) return next();
  if (!env.SITE_PASSWORD) {
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Login is not configured" }, 503);
    }
    return loginPage("\uB85C\uADF8\uC778 \uC124\uC815\uC774 \uC544\uC9C1 \uBC18\uC601\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694.", 503);
  }

  if (url.pathname === "/__auth/login") {
    return request.method === "POST" ? login(request, env) : loginPage();
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

async function login(request, env) {
  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (password !== env.SITE_PASSWORD) {
    return loginPage("비밀번호가 맞지 않습니다.", 401);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAt}`;
  const signature = await sign(payload, env);
  const cookie = [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ].join("; ");

  return redirect("/", { "Set-Cookie": cookie });
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
    <title>교구관리 로그인</title>
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
      .error {
        margin: 0 0 14px;
        color: #b42318;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">남아메리카 공동체</p>
      <h1>교구관리</h1>
      ${errorMarkup}
      <form method="post" action="/__auth/login">
        <label>
          관리자 비밀번호
          <input name="password" type="password" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">로그인</button>
      </form>
    </main>
  </body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
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
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${META_TITLE}">
    <meta name="twitter:description" content="${META_DESCRIPTION}">
    <meta name="twitter:image" content="${META_IMAGE}">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/favicon.png" type="image/png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
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

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
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

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
