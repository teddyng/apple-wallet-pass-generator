const http = require("http");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const USER_DB_PATH = process.env.USER_DB_PATH || path.join(ROOT, "data", "users.json");
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(ROOT, "data", "audit.log");
const DATABASE_URL = process.env.DATABASE_URL || "";
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SIGNING_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PASTED_PEM_BYTES = 128 * 1024;
const MAX_BULK_PASSES = 50;
const SESSION_COOKIE_NAME = "wallet_pass_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const ADMIN_USERNAME = normalizeUsername(process.env.ADMIN_USERNAME || "admin");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto
  .createHash("sha256")
  .update(`${ADMIN_PASSWORD || "missing-password"}:${os.hostname()}:wallet-pass-studio`)
  .digest("hex");
const PUBLIC_ASSETS = new Set(["/styles.css", "/login.js", "/admin.js", "/theme.js"]);
const RATE_LIMITS = new Map();
const RATE_LIMIT_RULES = {
  auth: { limit: 12, windowMs: 10 * 60 * 1000 },
  generate: { limit: 20, windowMs: 10 * 60 * 1000 },
  admin: { limit: 80, windowMs: 10 * 60 * 1000 }
};
const LOGIN_AUDIT_EVENTS = new Set([
  "login_success",
  "login_failed",
  "login_pending",
  "login_inactive",
  "login_setup_missing"
]);
let postgresPool = null;
let postgresSchemaReady = false;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sendErrorPage(res, status, title, message) {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} | Wallet Pass Studio</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="/theme.js" defer></script>
  </head>
  <body>
    <main class="login-shell">
      <section class="login-panel">
        <div class="login-heading">
          <span class="eyebrow">Apple Wallet</span>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <p class="login-copy">${escapeHtml(message)}</p>
        <a class="primary-button" href="/">Back to studio</a>
      </section>
      <footer class="site-footer login-footer">
        <span>Created by Teddy Ng. Powered by Codex. Hosted by Render and Neon.</span>
      </footer>
    </main>
  </body>
</html>`;
  res.writeHead(status, {
    "content-type": MIME_TYPES[".html"],
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendRedirect(res, location, headers = {}) {
  res.writeHead(303, {
    location,
    "cache-control": "no-store",
    ...headers
  });
  res.end();
}

function collectText(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UserError("The request is too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function collectJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UserError("The request is too large. Remove oversized image files and try again.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new UserError("The request body was not valid JSON."));
      }
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = String(input).replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function hmac(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeUsername(value) {
  return stringValue(value).toLowerCase();
}

function assertValidUsername(username) {
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new UserError("Usernames must be 3-40 characters using letters, numbers, dots, dashes, or underscores.");
  }
}

function assertValidPassword(password) {
  if (String(password).length < 8) {
    throw new UserError("Passwords must be at least 8 characters.");
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [algorithm, salt, expected] = String(passwordHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;

  const actual = crypto.scryptSync(String(password), salt, 64).toString("base64url");
  return timingSafeStringEqual(actual, expected);
}

function emptyUserStore() {
  return {
    users: [],
    resetRequests: []
  };
}

async function loadUserStore() {
  if (DATABASE_URL) return loadPostgresUserStore();
  return loadFileUserStore();
}

async function saveUserStore(store) {
  if (DATABASE_URL) {
    await savePostgresUserStore(store);
    return;
  }
  await saveFileUserStore(store);
}

async function loadFileUserStore() {
  let store;
  try {
    store = JSON.parse(await fs.readFile(USER_DB_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    store = emptyUserStore();
  }

  if (!Array.isArray(store.users)) store.users = [];
  if (!Array.isArray(store.resetRequests)) store.resetRequests = [];

  const adminExists = store.users.some((user) => normalizeUsername(user.username) === ADMIN_USERNAME);
  if (!adminExists && ADMIN_PASSWORD) {
    store.users.push({
      username: ADMIN_USERNAME,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      role: "admin",
      status: "active",
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString()
    });
    await saveUserStore(store);
  }

  return store;
}

async function saveFileUserStore(store) {
  await fs.mkdir(path.dirname(USER_DB_PATH), { recursive: true });
  const tmpPath = `${USER_DB_PATH}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  await fs.rename(tmpPath, USER_DB_PATH);
}

function requirePg() {
  try {
    return require("pg");
  } catch {
    throw new UserError("DATABASE_URL is set, but the Postgres driver is not installed. Redeploy after pushing the updated package.json.", 500);
  }
}

function getPostgresPool() {
  if (!DATABASE_URL) return null;
  if (!postgresPool) {
    const { Pool } = requirePg();
    postgresPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
      max: 4,
      idleTimeoutMillis: 30000
    });
  }
  return postgresPool;
}

async function ensurePostgresSchema() {
  const pool = getPostgresPool();
  if (!pool || postgresSchemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL,
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS reset_requests (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event TEXT NOT NULL,
      actor TEXT,
      ip TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  postgresSchemaReady = true;
}

function isoDate(value) {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function dbUser(row) {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    createdAt: isoDate(row.created_at),
    approvedAt: isoDate(row.approved_at),
    rejectedAt: isoDate(row.rejected_at)
  };
}

function dbResetRequest(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: isoDate(row.created_at),
    resolvedAt: isoDate(row.resolved_at)
  };
}

async function seedPostgresAdmin(pool) {
  if (!ADMIN_PASSWORD) return;
  await pool.query(`
    INSERT INTO users (username, password_hash, role, status, created_at, approved_at)
    VALUES ($1, $2, 'admin', 'active', NOW(), NOW())
    ON CONFLICT (username) DO NOTHING
  `, [ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD)]);
}

async function loadPostgresUserStore() {
  await ensurePostgresSchema();
  const pool = getPostgresPool();
  await seedPostgresAdmin(pool);

  const [usersResult, resetsResult] = await Promise.all([
    pool.query("SELECT * FROM users ORDER BY created_at ASC, username ASC"),
    pool.query("SELECT * FROM reset_requests ORDER BY created_at ASC")
  ]);

  return {
    users: usersResult.rows.map(dbUser),
    resetRequests: resetsResult.rows.map(dbResetRequest)
  };
}

function nullableDate(value) {
  return value ? new Date(value) : null;
}

async function savePostgresUserStore(store) {
  await ensurePostgresSchema();
  const pool = getPostgresPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM reset_requests");
    await client.query("DELETE FROM users");

    for (const user of store.users) {
      await client.query(`
        INSERT INTO users (username, password_hash, role, status, created_at, approved_at, rejected_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        normalizeUsername(user.username),
        user.passwordHash,
        user.role,
        user.status,
        nullableDate(user.createdAt) || new Date(),
        nullableDate(user.approvedAt),
        nullableDate(user.rejectedAt)
      ]);
    }

    for (const request of store.resetRequests) {
      await client.query(`
        INSERT INTO reset_requests (id, username, password_hash, status, created_at, resolved_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        request.id,
        normalizeUsername(request.username),
        request.passwordHash,
        request.status,
        nullableDate(request.createdAt) || new Date(),
        nullableDate(request.resolvedAt)
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function findUser(store, username) {
  const normalized = normalizeUsername(username);
  return store.users.find((user) => normalizeUsername(user.username) === normalized) || null;
}

function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
    rejectedAt: user.rejectedAt
  };
}

function publicResetRequest(request) {
  return {
    id: request.id,
    username: request.username,
    status: request.status,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt
  };
}

function auditUsername(entry) {
  const details = entry && typeof entry.details === "object" && entry.details ? entry.details : {};
  return stringValue(details.username || entry.username || entry.actor, "unknown");
}

function publicLoginLog(entry) {
  return {
    at: isoDate(entry.at),
    username: auditUsername(entry),
    event: stringValue(entry.event, "login_unknown"),
    ip: stringValue(entry.ip, "unknown")
  };
}

function auditEntryFromPostgresRow(row) {
  return {
    at: isoDate(row.at),
    event: row.event,
    actor: row.actor,
    ip: row.ip,
    details: row.details && typeof row.details === "object" ? row.details : {}
  };
}

async function loadPostgresAuditEntries(limit = 500) {
  await ensurePostgresSchema();
  const pool = getPostgresPool();
  const result = await pool.query(`
    SELECT at, event, actor, ip, details
    FROM audit_log
    ORDER BY at DESC, id DESC
    LIMIT $1
  `, [limit]);
  return result.rows.map(auditEntryFromPostgresRow);
}

async function loadFileAuditEntries(limit = 500) {
  let text = "";
  try {
    text = await fs.readFile(AUDIT_LOG_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return text
    .split("\n")
    .filter(Boolean)
    .reverse()
    .slice(0, limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function loadAuditEntries(limit = 500) {
  if (DATABASE_URL) return loadPostgresAuditEntries(limit);
  return loadFileAuditEntries(limit);
}

function isWithinHours(value, hours) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() <= hours * 60 * 60 * 1000;
}

function buildAdminMetrics(store, auditEntries) {
  const activeUsers = store.users.filter((user) => user.status === "active").length;
  const pendingUsers = store.users.filter((user) => user.status === "pending").length;
  const pendingResets = store.resetRequests.filter((request) => request.status === "pending").length;
  const lastDayEntries = auditEntries.filter((entry) => isWithinHours(entry.at, 24));

  const generatedPasses24h = lastDayEntries.reduce((count, entry) => {
    if (entry.event === "pass_generated") return count + 1;
    if (entry.event === "bulk_passes_generated") {
      const details = entry.details && typeof entry.details === "object" ? entry.details : {};
      const bulkCount = Number(details.count);
      return count + (Number.isFinite(bulkCount) && bulkCount > 0 ? bulkCount : 0);
    }
    return count;
  }, 0);

  return {
    totalUsers: store.users.length,
    activeUsers,
    pendingUsers,
    pendingResets,
    successfulLogins24h: lastDayEntries.filter((entry) => entry.event === "login_success").length,
    failedLogins24h: lastDayEntries.filter((entry) => entry.event === "login_failed").length,
    generatedPasses24h
  };
}

function createSessionToken(user) {
  const payload = base64Url(JSON.stringify({
    username: user.username,
    role: user.role,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
    nonce: crypto.randomBytes(16).toString("hex")
  }));
  return `${payload}.${hmac(payload)}`;
}

function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token || !token.includes(".")) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature || !timingSafeStringEqual(signature, hmac(payload))) return null;

  try {
    const session = JSON.parse(fromBase64Url(payload));
    if (!session.exp || Date.now() > session.exp) return null;
    if (!session.username || !["admin", "user"].includes(session.role)) return null;
    return session;
  } catch {
    return null;
  }
}

function isAuthenticated(req) {
  return Boolean(readSession(req));
}

function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
}

function sessionCookie(req, token) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

function expiredSessionCookie(req) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req, bucket) {
  const rule = RATE_LIMIT_RULES[bucket];
  if (!rule) return;

  const now = Date.now();
  const key = `${bucket}:${clientIp(req)}`;
  const existing = RATE_LIMITS.get(key);
  const entry = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + rule.windowMs };

  entry.count += 1;
  RATE_LIMITS.set(key, entry);

  if (entry.count > rule.limit) {
    throw new UserError("Too many attempts. Please wait a few minutes and try again.", 429);
  }

  if (RATE_LIMITS.size > 1000) {
    for (const [rateKey, value] of RATE_LIMITS) {
      if (value.resetAt <= now) RATE_LIMITS.delete(rateKey);
    }
  }
}

async function audit(event, details = {}, req = null) {
  const session = req ? readSession(req) : null;
  const entry = {
    at: new Date().toISOString(),
    event,
    actor: session ? session.username : null,
    ip: req ? clientIp(req) : null,
    ...details
  };

  try {
    if (DATABASE_URL) {
      await ensurePostgresSchema();
      const pool = getPostgresPool();
      const detailPayload = { ...details };
      await pool.query(`
        INSERT INTO audit_log (at, event, actor, ip, details)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `, [
        entry.at,
        event,
        session ? session.username : null,
        req ? clientIp(req) : null,
        JSON.stringify(detailPayload)
      ]);
      return;
    }

    await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    await fs.appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.warn(`Audit log write failed: ${error.message}`);
  }
}

function resolvePublicPath(requestPath) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const decoded = decodeURIComponent(cleanPath);
  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    throw new UserError("File not found.", 404);
  }
  return filePath;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const filePath = resolvePublicPath(url.pathname);
  const ext = path.extname(filePath).toLowerCase();

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      throw new UserError("File not found.", 404);
    }
    throw error;
  }
}

async function serveLogin(req, res) {
  const filePath = path.join(PUBLIC_DIR, "login.html");
  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[".html"],
    "cache-control": "no-store"
  });
  res.end(data);
}

async function serveAdmin(req, res) {
  const filePath = path.join(PUBLIC_DIR, "admin.html");
  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[".html"],
    "cache-control": "no-store"
  });
  res.end(data);
}

async function handleLogin(req, res) {
  checkRateLimit(req, "auth");
  const body = await collectText(req);
  const form = new URLSearchParams(body);
  const username = normalizeUsername(form.get("username"));
  const password = String(form.get("password") || "");

  const store = await loadUserStore();
  const user = findUser(store, username);

  if (!user && !ADMIN_PASSWORD && username === ADMIN_USERNAME) {
    await audit("login_setup_missing", { username }, req);
    sendRedirect(res, "/login?error=setup");
    return;
  }

  if (!user || !verifyPassword(password, user.passwordHash)) {
    await audit("login_failed", { username }, req);
    sendRedirect(res, "/login?error=invalid");
    return;
  }

  if (user.status === "pending") {
    await audit("login_pending", { username }, req);
    sendRedirect(res, "/login?error=pending");
    return;
  }

  if (user.status !== "active") {
    await audit("login_inactive", { username }, req);
    sendRedirect(res, "/login?error=inactive");
    return;
  }

  await audit("login_success", { username }, req);
  sendRedirect(res, "/", {
    "set-cookie": sessionCookie(req, createSessionToken(user))
  });
}

async function handleRegister(req, res) {
  checkRateLimit(req, "auth");
  const body = await collectText(req);
  const form = new URLSearchParams(body);
  const username = normalizeUsername(form.get("username"));
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");

  try {
    assertValidUsername(username);
    assertValidPassword(password);
    if (password !== confirmPassword) throw new UserError("Passwords do not match.");

    const store = await loadUserStore();
    const existing = findUser(store, username);
    if (existing && existing.status !== "rejected") {
      throw new UserError("That username already exists or is awaiting approval.");
    }

    if (existing && existing.status === "rejected") {
      existing.passwordHash = hashPassword(password);
      existing.status = "pending";
      existing.role = "user";
      existing.rejectedAt = undefined;
      existing.createdAt = new Date().toISOString();
    } else {
      store.users.push({
        username,
        passwordHash: hashPassword(password),
        role: "user",
        status: "pending",
        createdAt: new Date().toISOString()
      });
    }

    await saveUserStore(store);
    await audit("account_requested", { username }, req);
    sendRedirect(res, "/login?notice=registered");
  } catch (error) {
    const message = error instanceof UserError ? encodeURIComponent(error.message) : "request";
    sendRedirect(res, `/login?error=${message}`);
  }
}

async function handlePasswordResetRequest(req, res) {
  checkRateLimit(req, "auth");
  const body = await collectText(req);
  const form = new URLSearchParams(body);
  const username = normalizeUsername(form.get("username"));
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");

  try {
    assertValidUsername(username);
    assertValidPassword(password);
    if (password !== confirmPassword) throw new UserError("Passwords do not match.");

    const store = await loadUserStore();
    const user = findUser(store, username);
    if (!user || user.status !== "active") {
      throw new UserError("That account is not active.");
    }

    store.resetRequests = store.resetRequests.filter((request) => {
      return !(request.username === username && request.status === "pending");
    });
    store.resetRequests.push({
      id: crypto.randomUUID(),
      username,
      passwordHash: hashPassword(password),
      status: "pending",
      createdAt: new Date().toISOString()
    });

    await saveUserStore(store);
    await audit("password_reset_requested", { username }, req);
    sendRedirect(res, "/login?notice=reset");
  } catch (error) {
    const message = error instanceof UserError ? encodeURIComponent(error.message) : "request";
    sendRedirect(res, `/login?error=${message}`);
  }
}

function requireAdmin(req, res) {
  const session = readSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Sign in first." });
    return null;
  }
  if (session.role !== "admin") {
    sendJson(res, 403, { error: "Admin access is required." });
    return null;
  }
  return session;
}

async function handleMe(req, res) {
  const session = readSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Sign in first." });
    return;
  }
  sendJson(res, 200, {
    username: session.username,
    role: session.role
  });
}

async function handleAdminState(req, res) {
  checkRateLimit(req, "admin");
  if (!requireAdmin(req, res)) return;
  const [store, auditEntries] = await Promise.all([
    loadUserStore(),
    loadAuditEntries(500)
  ]);
  const loginLogs = auditEntries
    .filter((entry) => LOGIN_AUDIT_EVENTS.has(entry.event))
    .slice(0, 50)
    .map(publicLoginLog);

  sendJson(res, 200, {
    users: store.users.map(publicUser),
    resetRequests: store.resetRequests.map(publicResetRequest),
    loginLogs,
    metrics: buildAdminMetrics(store, auditEntries)
  });
}

async function handleApproveUser(req, res) {
  checkRateLimit(req, "admin");
  if (!requireAdmin(req, res)) return;
  const input = await collectJson(req);
  const username = normalizeUsername(input.username);
  const store = await loadUserStore();
  const user = findUser(store, username);
  if (!user || user.status !== "pending") throw new UserError("Pending user not found.", 404);

  user.status = "active";
  user.role = user.role === "admin" ? "admin" : "user";
  user.approvedAt = new Date().toISOString();
  user.rejectedAt = undefined;
  await saveUserStore(store);
  await audit("user_approved", { username }, req);
  sendJson(res, 200, { user: publicUser(user) });
}

async function handleRejectUser(req, res) {
  checkRateLimit(req, "admin");
  if (!requireAdmin(req, res)) return;
  const input = await collectJson(req);
  const username = normalizeUsername(input.username);
  if (username === ADMIN_USERNAME) throw new UserError("The admin account cannot be rejected.");

  const store = await loadUserStore();
  const user = findUser(store, username);
  if (!user || user.status !== "pending") throw new UserError("Pending user not found.", 404);

  user.status = "rejected";
  user.rejectedAt = new Date().toISOString();
  await saveUserStore(store);
  await audit("user_rejected", { username }, req);
  sendJson(res, 200, { user: publicUser(user) });
}

async function handleDeleteUser(req, res) {
  checkRateLimit(req, "admin");
  if (!requireAdmin(req, res)) return;
  const input = await collectJson(req);
  const username = normalizeUsername(input.username);
  if (username === ADMIN_USERNAME) throw new UserError("The admin account cannot be deleted.");

  const store = await loadUserStore();
  const userIndex = store.users.findIndex((user) => normalizeUsername(user.username) === username);
  if (userIndex === -1) throw new UserError("User not found.", 404);

  const [deletedUser] = store.users.splice(userIndex, 1);
  store.resetRequests = store.resetRequests.filter((request) => request.username !== username);
  await saveUserStore(store);
  await audit("user_deleted", { username }, req);
  sendJson(res, 200, { user: publicUser(deletedUser) });
}

async function handleApproveReset(req, res) {
  checkRateLimit(req, "admin");
  if (!requireAdmin(req, res)) return;
  const input = await collectJson(req);
  const store = await loadUserStore();
  const request = store.resetRequests.find((item) => item.id === input.id);
  if (!request || request.status !== "pending") throw new UserError("Pending reset request not found.", 404);

  const user = findUser(store, request.username);
  if (!user || user.status !== "active") throw new UserError("Active user not found.", 404);

  user.passwordHash = request.passwordHash;
  request.status = "approved";
  request.resolvedAt = new Date().toISOString();
  await saveUserStore(store);
  await audit("password_reset_approved", { username: request.username }, req);
  sendJson(res, 200, { resetRequest: publicResetRequest(request) });
}

async function handleRejectReset(req, res) {
  checkRateLimit(req, "admin");
  if (!requireAdmin(req, res)) return;
  const input = await collectJson(req);
  const store = await loadUserStore();
  const request = store.resetRequests.find((item) => item.id === input.id);
  if (!request || request.status !== "pending") throw new UserError("Pending reset request not found.", 404);

  request.status = "rejected";
  request.resolvedAt = new Date().toISOString();
  await saveUserStore(store);
  await audit("password_reset_rejected", { username: request.username }, req);
  sendJson(res, 200, { resetRequest: publicResetRequest(request) });
}

function stringValue(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function boolValue(value) {
  return value === true || value === "true" || value === "on";
}

function sanitizeFileName(value, fallback = "wallet-pass") {
  return stringValue(value, fallback)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function normalizeBulkKey(value) {
  return stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function bulkRowLookup(row, candidates) {
  if (!row || typeof row !== "object") return { found: false, value: undefined };

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, candidate)) {
      return { found: true, value: row[candidate] };
    }
  }

  const keyMap = new Map();
  for (const key of Object.keys(row)) {
    keyMap.set(normalizeBulkKey(key), key);
  }

  for (const candidate of candidates) {
    const key = keyMap.get(normalizeBulkKey(candidate));
    if (key) return { found: true, value: row[key] };
  }

  return { found: false, value: undefined };
}

function applyBulkValue(target, key, row, candidates = [key]) {
  const match = bulkRowLookup(row, candidates);
  if (!match.found) return false;
  target[key] = match.value === undefined || match.value === null ? "" : String(match.value);
  return true;
}

function applyBulkBool(target, key, row, candidates = [key]) {
  const match = bulkRowLookup(row, candidates);
  if (!match.found) return false;
  target[key] = boolValue(match.value);
  return true;
}

function padBulkIndex(index) {
  return String(index + 1).padStart(3, "0");
}

function uniqueZipFileName(filename, usedNames) {
  const parsed = path.parse(sanitizeFileName(filename, "wallet-pass.pkpass"));
  const ext = parsed.ext || ".pkpass";
  const base = sanitizeFileName(parsed.name, "wallet-pass");
  let candidate = `${base}${ext}`;
  let count = 2;

  while (usedNames.has(candidate)) {
    candidate = `${base}-${count}${ext}`;
    count += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function applyBulkRow(template, row, index) {
  const input = cloneJson(template);
  input.pass = input.pass || {};
  input.colors = input.colors || {};
  input.barcode = input.barcode || {};
  input.locations = Array.isArray(input.locations) ? input.locations : [];

  const templateSerial = stringValue(template && template.pass && template.pass.serialNumber, "PASS");
  const serialMatch = bulkRowLookup(row, ["serialNumber", "serial", "id", "passId"]);
  const serialNumber = serialMatch.found && stringValue(serialMatch.value)
    ? stringValue(serialMatch.value)
    : `${templateSerial}-${padBulkIndex(index)}`;
  input.pass.serialNumber = serialNumber;

  const passTextKeys = [
    "passTypeIdentifier",
    "teamIdentifier",
    "organizationName",
    "description",
    "logoText",
    "relevantDate",
    "expirationDate",
    "associatedStoreIdentifiers",
    "passStyle",
    "transitType"
  ];
  for (const key of passTextKeys) applyBulkValue(input.pass, key, row);
  applyBulkBool(input.pass, "sharingProhibited", row);
  applyBulkBool(input.pass, "voided", row);

  for (const key of ["backgroundColor", "foregroundColor", "labelColor"]) {
    applyBulkValue(input.colors, key, row);
  }

  applyBulkBool(input.barcode, "enabled", row, ["barcodeEnabled", "includeBarcode"]);
  applyBulkValue(input.barcode, "format", row, ["barcodeFormat", "format"]);
  const barcodeOverridden = applyBulkValue(input.barcode, "message", row, ["barcodeMessage", "barcode", "qr", "code"]);
  const altTextOverridden = applyBulkValue(input.barcode, "altText", row, ["barcodeAltText", "altText"]);
  applyBulkValue(input.barcode, "encoding", row, ["barcodeEncoding", "messageEncoding"]);

  const templateBarcodeMessage = stringValue(template && template.barcode && template.barcode.message);
  if (!barcodeOverridden && templateBarcodeMessage === templateSerial) {
    input.barcode.message = serialNumber;
  }
  if (!altTextOverridden && stringValue(template && template.barcode && template.barcode.altText) === templateSerial) {
    input.barcode.altText = serialNumber;
  }

  const latitude = bulkRowLookup(row, ["locationLatitude", "latitude", "lat"]);
  const longitude = bulkRowLookup(row, ["locationLongitude", "longitude", "lng", "lon"]);
  const relevantText = bulkRowLookup(row, ["locationText", "relevantText"]);
  if (latitude.found || longitude.found || relevantText.found) {
    input.locations = [{
      latitude: latitude.found ? latitude.value : "",
      longitude: longitude.found ? longitude.value : "",
      relevantText: relevantText.found ? relevantText.value : ""
    }];
  }

  const fieldCollections = [
    ["primaryFields", "primary"],
    ["secondaryFields", "secondary"],
    ["auxiliaryFields", "auxiliary"],
    ["backFields", "back"]
  ];

  for (const [collection, prefix] of fieldCollections) {
    if (!Array.isArray(input[collection])) continue;
    for (const field of input[collection]) {
      const key = stringValue(field.key);
      if (!key) continue;
      const match = bulkRowLookup(row, [key, `${prefix}.${key}`, `${collection}.${key}`]);
      if (match.found) field.value = match.value === undefined || match.value === null ? "" : String(match.value);
    }
  }

  return input;
}

function sanitizeKey(value, fallback) {
  const key = stringValue(value, fallback).replace(/[^a-zA-Z0-9_-]/g, "_");
  return key || fallback;
}

function parseHexColor(value, fallback) {
  const hex = stringValue(value, fallback).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return parseHexColor(fallback, "#111827");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function walletColor(value, fallback) {
  const text = stringValue(value, fallback);
  if (/^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i.test(text)) return text;
  const color = parseHexColor(text, fallback);
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function normalizeDateTime(value) {
  const text = stringValue(value);
  if (!text) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function buildFieldList(items, prefix) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item, index) => {
      const value = item && item.value !== undefined ? String(item.value).trim() : "";
      if (!value) return null;

      const field = {
        key: sanitizeKey(item.key, `${prefix}${index + 1}`),
        label: stringValue(item.label),
        value
      };

      const alignment = stringValue(item.textAlignment);
      if (["PKTextAlignmentLeft", "PKTextAlignmentCenter", "PKTextAlignmentRight", "PKTextAlignmentNatural"].includes(alignment)) {
        field.textAlignment = alignment;
      }

      const changeMessage = stringValue(item.changeMessage);
      if (changeMessage) field.changeMessage = changeMessage;

      return field;
    })
    .filter(Boolean);
}

function buildPassJson(input) {
  const pass = input.pass || {};
  const colors = input.colors || {};
  const barcode = input.barcode || {};

  const passTypeIdentifier = stringValue(pass.passTypeIdentifier);
  const teamIdentifier = stringValue(pass.teamIdentifier);
  const organizationName = stringValue(pass.organizationName);
  const description = stringValue(pass.description, "Wallet pass");

  if (!passTypeIdentifier) throw new UserError("Pass Type Identifier is required.");
  if (!teamIdentifier) throw new UserError("Team Identifier is required.");
  if (!organizationName) throw new UserError("Organization Name is required.");

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier,
    serialNumber: stringValue(pass.serialNumber, crypto.randomUUID()),
    teamIdentifier,
    organizationName,
    description,
    logoText: stringValue(pass.logoText, organizationName),
    foregroundColor: walletColor(colors.foregroundColor, "#ffffff"),
    labelColor: walletColor(colors.labelColor, "#dbeafe"),
    backgroundColor: walletColor(colors.backgroundColor, "#1d4ed8")
  };

  const expirationDate = normalizeDateTime(pass.expirationDate);
  if (expirationDate) passJson.expirationDate = expirationDate;

  const relevantDate = normalizeDateTime(pass.relevantDate);
  if (relevantDate) passJson.relevantDate = relevantDate;

  if (boolValue(pass.sharingProhibited)) passJson.sharingProhibited = true;
  if (boolValue(pass.voided)) passJson.voided = true;

  const style = ["generic", "coupon", "storeCard", "eventTicket", "boardingPass"].includes(pass.passStyle)
    ? pass.passStyle
    : "generic";

  const stylePayload = {
    primaryFields: buildFieldList(input.primaryFields, "primary"),
    secondaryFields: buildFieldList(input.secondaryFields, "secondary"),
    auxiliaryFields: buildFieldList(input.auxiliaryFields, "auxiliary"),
    backFields: buildFieldList(input.backFields, "back")
  };

  if (style === "boardingPass") {
    const transitType = stringValue(pass.transitType, "PKTransitTypeGeneric");
    stylePayload.transitType = [
      "PKTransitTypeAir",
      "PKTransitTypeBoat",
      "PKTransitTypeBus",
      "PKTransitTypeGeneric",
      "PKTransitTypeTrain"
    ].includes(transitType) ? transitType : "PKTransitTypeGeneric";
  }

  passJson[style] = stylePayload;

  const barcodeMessage = stringValue(barcode.message);
  if (boolValue(barcode.enabled) && barcodeMessage) {
    const format = [
      "PKBarcodeFormatQR",
      "PKBarcodeFormatPDF417",
      "PKBarcodeFormatAztec",
      "PKBarcodeFormatCode128"
    ].includes(barcode.format) ? barcode.format : "PKBarcodeFormatQR";

    const payload = {
      format,
      message: barcodeMessage,
      messageEncoding: stringValue(barcode.encoding, "iso-8859-1")
    };

    const altText = stringValue(barcode.altText);
    if (altText) payload.altText = altText;

    passJson.barcodes = [payload];
    passJson.barcode = payload;
  }

  const storeIds = stringValue(pass.associatedStoreIdentifiers)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  if (storeIds.length) passJson.associatedStoreIdentifiers = storeIds;

  const locations = Array.isArray(input.locations) ? input.locations : [];
  const cleanLocations = locations
    .map((location) => {
      const latitude = Number(location.latitude);
      const longitude = Number(location.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const output = { latitude, longitude };
      const relevantText = stringValue(location.relevantText);
      if (relevantText) output.relevantText = relevantText;
      return output;
    })
    .filter(Boolean);
  if (cleanLocations.length) passJson.locations = cleanLocations;

  return passJson;
}

function filePayloadToBuffer(payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    return Buffer.from(payload, "utf8");
  }
  if (payload.text) {
    return Buffer.from(String(payload.text), "utf8");
  }
  if (payload.data) {
    const base64 = String(payload.data).includes(",")
      ? String(payload.data).split(",").pop()
      : String(payload.data);
    return Buffer.from(base64, "base64");
  }
  return null;
}

function payloadBytes(payload) {
  if (!payload) return 0;
  if (payload.text) return Buffer.byteLength(String(payload.text), "utf8");
  if (payload.data) {
    const base64 = String(payload.data).includes(",")
      ? String(payload.data).split(",").pop()
      : String(payload.data);
    return Buffer.from(base64, "base64").length;
  }
  if (typeof payload === "string") return Buffer.byteLength(payload, "utf8");
  return 0;
}

function assertAllowedUpload(payload, label, options) {
  if (!payload) return;
  const bytes = payloadBytes(payload);
  if (bytes > options.maxBytes) {
    throw new UserError(`${label} is too large. Max size is ${Math.round(options.maxBytes / 1024 / 1024)} MB.`);
  }

  const name = stringValue(payload.name).toLowerCase();
  if (!name || !options.extensions) return;
  const allowed = options.extensions.some((extension) => name.endsWith(extension));
  if (!allowed) {
    throw new UserError(`${label} must use one of these file types: ${options.extensions.join(", ")}.`);
  }
}

function validateUploadPayloads(input) {
  const images = input.images || {};
  const signing = input.signing || {};

  const imageKeys = [
    "icon", "icon2x", "icon3x", "logo", "logo2x", "strip", "strip2x",
    "thumbnail", "thumbnail2x", "background", "background2x", "footer", "footer2x"
  ];
  for (const key of imageKeys) {
    assertAllowedUpload(images[key], `${key} image`, {
      maxBytes: MAX_IMAGE_BYTES,
      extensions: [".png"]
    });
  }

  if (signing.mode === "p12") {
    assertAllowedUpload(signing.p12, "P12 certificate", {
      maxBytes: MAX_SIGNING_FILE_BYTES,
      extensions: [".p12", ".pfx"]
    });
    assertAllowedUpload(signing.wwdrCertificate, "WWDR certificate", {
      maxBytes: MAX_SIGNING_FILE_BYTES,
      extensions: [".cer", ".der", ".pem", ".crt"]
    });
    return;
  }

  assertAllowedUpload(signing.certificate, "Signing certificate", {
    maxBytes: signing.certificate && signing.certificate.text ? MAX_PASTED_PEM_BYTES : MAX_SIGNING_FILE_BYTES,
    extensions: [".cer", ".der", ".pem", ".crt"]
  });
  assertAllowedUpload(signing.privateKey, "Private key", {
    maxBytes: signing.privateKey && signing.privateKey.text ? MAX_PASTED_PEM_BYTES : MAX_SIGNING_FILE_BYTES,
    extensions: [".pem", ".key"]
  });
  assertAllowedUpload(signing.wwdrCertificate, "WWDR certificate", {
    maxBytes: signing.wwdrCertificate && signing.wwdrCertificate.text ? MAX_PASTED_PEM_BYTES : MAX_SIGNING_FILE_BYTES,
    extensions: [".cer", ".der", ".pem", ".crt"]
  });
}

function assertPng(buffer, label) {
  const pngSignature = "89504e470d0a1a0a";
  if (!buffer || buffer.length < 8 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new UserError(`${label} must be a PNG file.`);
  }
}

async function writePngPayload(bundleDir, filename, payload, label) {
  const buffer = filePayloadToBuffer(payload);
  if (!buffer || !buffer.length) return false;
  assertPng(buffer, label);
  await fs.writeFile(path.join(bundleDir, filename), buffer);
  return true;
}

async function writeImages(bundleDir, input) {
  const images = input.images || {};
  const colors = input.colors || {};
  const background = stringValue(colors.backgroundColor, "#1d4ed8");

  const hasIcon = await writePngPayload(bundleDir, "icon.png", images.icon, "Icon");
  if (hasIcon) {
    await writePngPayload(bundleDir, "icon@2x.png", images.icon2x || images.icon, "Icon @2x");
    await writePngPayload(bundleDir, "icon@3x.png", images.icon3x || images.icon2x || images.icon, "Icon @3x");
  } else {
    await fs.writeFile(path.join(bundleDir, "icon.png"), makeDefaultPassPng(29, 29, background));
    await fs.writeFile(path.join(bundleDir, "icon@2x.png"), makeDefaultPassPng(58, 58, background));
    await fs.writeFile(path.join(bundleDir, "icon@3x.png"), makeDefaultPassPng(87, 87, background));
  }

  await writePngPayload(bundleDir, "logo.png", images.logo, "Logo");
  await writePngPayload(bundleDir, "logo@2x.png", images.logo2x || images.logo, "Logo @2x");
  await writePngPayload(bundleDir, "strip.png", images.strip, "Strip");
  await writePngPayload(bundleDir, "strip@2x.png", images.strip2x || images.strip, "Strip @2x");
  await writePngPayload(bundleDir, "thumbnail.png", images.thumbnail, "Thumbnail");
  await writePngPayload(bundleDir, "thumbnail@2x.png", images.thumbnail2x || images.thumbnail, "Thumbnail @2x");
  await writePngPayload(bundleDir, "background.png", images.background, "Background");
  await writePngPayload(bundleDir, "background@2x.png", images.background2x || images.background, "Background @2x");
  await writePngPayload(bundleDir, "footer.png", images.footer, "Footer");
  await writePngPayload(bundleDir, "footer@2x.png", images.footer2x || images.footer, "Footer @2x");
}

async function createManifest(bundleDir) {
  const names = await fs.readdir(bundleDir);
  const manifest = {};

  for (const name of names.sort()) {
    if (name === "manifest.json" || name === "signature" || name.startsWith(".")) continue;
    const fullPath = path.join(bundleDir, name);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) continue;
    const data = await fs.readFile(fullPath);
    manifest[name] = crypto.createHash("sha1").update(data).digest("hex");
  }

  return manifest;
}

async function writeCertificatePem(payload, outputPath, label) {
  const buffer = filePayloadToBuffer(payload);
  if (!buffer || !buffer.length) {
    throw new UserError(`${label} is required.`);
  }

  const text = buffer.toString("utf8");
  if (text.includes("-----BEGIN CERTIFICATE-----")) {
    await fs.writeFile(outputPath, text);
    return outputPath;
  }

  const derPath = `${outputPath}.der`;
  await fs.writeFile(derPath, buffer);
  try {
    await execOpenSsl(["x509", "-inform", "DER", "-in", derPath, "-out", outputPath], `Could not read ${label}.`);
    return outputPath;
  } catch (error) {
    throw error instanceof UserError ? error : new UserError(`Could not read ${label}. Use PEM or DER certificate format.`);
  }
}

async function writePrivateKeyPem(payload, outputPath) {
  const buffer = filePayloadToBuffer(payload);
  if (!buffer || !buffer.length) {
    throw new UserError("Private Key is required.");
  }
  const text = buffer.toString("utf8");
  if (!text.includes("-----BEGIN") || !text.includes("PRIVATE KEY-----")) {
    throw new UserError("Private Key must be PEM format. Use P12 mode for .p12 files.");
  }
  await fs.writeFile(outputPath, text);
  return outputPath;
}

function hasCertificatePem(filePath) {
  if (!fsSync.existsSync(filePath)) return false;
  const data = fsSync.readFileSync(filePath, "utf8");
  return data.includes("-----BEGIN CERTIFICATE-----");
}

async function prepareSigning(tmpRoot, input) {
  const signing = input.signing || {};
  const signingDir = path.join(tmpRoot, "signing");
  await fs.mkdir(signingDir, { recursive: true });

  const signerCertPath = path.join(signingDir, "signer.pem");
  const privateKeyPath = path.join(signingDir, "private-key.pem");
  const wwdrPath = path.join(signingDir, "wwdr.pem");

  if (signing.mode === "p12") {
    const p12 = filePayloadToBuffer(signing.p12);
    if (!p12 || !p12.length) {
      throw new UserError("P12 certificate is required.");
    }
    const p12Path = path.join(signingDir, "certificate.p12");
    await fs.writeFile(p12Path, p12);
    const passin = `pass:${stringValue(signing.p12Password)}`;

    await execOpenSsl([
      "pkcs12",
      "-in",
      p12Path,
      "-clcerts",
      "-nokeys",
      "-out",
      signerCertPath,
      "-passin",
      passin
    ], "Could not extract the signing certificate from the P12 file.");

    await execOpenSsl([
      "pkcs12",
      "-in",
      p12Path,
      "-nocerts",
      "-nodes",
      "-out",
      privateKeyPath,
      "-passin",
      passin
    ], "Could not extract the private key from the P12 file.");

    if (signing.wwdrCertificate) {
      await writeCertificatePem(signing.wwdrCertificate, wwdrPath, "WWDR Certificate");
    } else {
      try {
        await execOpenSsl([
          "pkcs12",
          "-in",
          p12Path,
          "-cacerts",
          "-nokeys",
          "-out",
          wwdrPath,
          "-passin",
          passin
        ], "Could not extract an intermediate certificate from the P12 file.");
      } catch {
        // The explicit WWDR validation below will provide the user-facing error.
      }
    }

    if (!hasCertificatePem(wwdrPath)) {
      throw new UserError("WWDR Certificate is required. Add the Apple Worldwide Developer Relations intermediate certificate.");
    }

    return {
      signerCertPath,
      privateKeyPath,
      wwdrPath,
      privateKeyPassphrase: ""
    };
  }

  await writeCertificatePem(signing.certificate, signerCertPath, "Signing Certificate");
  await writePrivateKeyPem(signing.privateKey, privateKeyPath);
  await writeCertificatePem(signing.wwdrCertificate, wwdrPath, "WWDR Certificate");

  return {
    signerCertPath,
    privateKeyPath,
    wwdrPath,
    privateKeyPassphrase: stringValue(signing.privateKeyPassphrase)
  };
}

async function signManifest(bundleDir, signingInfo) {
  const outputPath = path.join(bundleDir, "signature");
  const args = [
    "smime",
    "-binary",
    "-sign",
    "-certfile",
    signingInfo.wwdrPath,
    "-signer",
    signingInfo.signerCertPath,
    "-inkey",
    signingInfo.privateKeyPath,
    "-in",
    path.join(bundleDir, "manifest.json"),
    "-out",
    outputPath,
    "-outform",
    "DER"
  ];

  if (signingInfo.privateKeyPassphrase) {
    args.push("-passin", `pass:${signingInfo.privateKeyPassphrase}`);
  }

  await execOpenSsl(args, "Could not sign the pass manifest.");
  return outputPath;
}

async function packagePass(bundleDir, outputPath) {
  await execFileAsync("zip", ["-qr", outputPath, "."], {
    cwd: bundleDir,
    maxBuffer: 1024 * 1024
  });
}

async function execOpenSsl(args, fallbackMessage) {
  try {
    return await execFileAsync("openssl", args, { maxBuffer: 1024 * 1024 * 4 });
  } catch (error) {
    const details = String(error.stderr || error.message || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" ");
    throw new UserError(details ? `${fallbackMessage} ${details}` : fallbackMessage);
  }
}

async function generatePass(input) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wallet-pass-"));
  const bundleDir = path.join(tmpRoot, "bundle");
  const outputPath = path.join(tmpRoot, "pass.pkpass");

  try {
    await fs.mkdir(bundleDir, { recursive: true });

    const passJson = buildPassJson(input);
    await fs.writeFile(path.join(bundleDir, "pass.json"), `${JSON.stringify(passJson, null, 2)}\n`);
    await writeImages(bundleDir, input);

    const manifest = await createManifest(bundleDir);
    await fs.writeFile(path.join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const signingInfo = await prepareSigning(tmpRoot, input);
    await signManifest(bundleDir, signingInfo);
    await packagePass(bundleDir, outputPath);

    const data = await fs.readFile(outputPath);
    return {
      data,
      filename: `${sanitizeFileName(passJson.serialNumber)}.pkpass`
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function handleGenerate(req, res) {
  checkRateLimit(req, "generate");
  const input = await collectJson(req);
  validateUploadPayloads(input);
  const result = await generatePass(input);
  const session = readSession(req);
  await audit("pass_generated", {
    username: session ? session.username : null,
    passStyle: stringValue(input.pass && input.pass.passStyle, "generic")
  }, req);
  res.writeHead(200, {
    "content-type": "application/vnd.apple.pkpass",
    "content-disposition": `attachment; filename="${result.filename}"`,
    "content-length": result.data.length,
    "cache-control": "no-store"
  });
  res.end(result.data);
}

async function handleGenerateBulk(req, res) {
  checkRateLimit(req, "generate");
  const input = await collectJson(req);
  const template = input.template || {};
  const rows = Array.isArray(input.rows) ? input.rows : [];

  if (!rows.length) throw new UserError("Add at least one bulk row.");
  if (rows.length > MAX_BULK_PASSES) {
    throw new UserError(`Bulk creation is limited to ${MAX_BULK_PASSES} passes at a time.`);
  }

  validateUploadPayloads(template);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wallet-pass-bulk-"));
  const zipDir = path.join(tmpRoot, "passes");
  const zipPath = path.join(tmpRoot, "wallet-passes.zip");
  const usedNames = new Set();

  try {
    await fs.mkdir(zipDir, { recursive: true });

    for (const [index, row] of rows.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new UserError(`Bulk row ${index + 1} is not valid.`);
      }

      const rowInput = applyBulkRow(template, row, index);
      const result = await generatePass(rowInput);
      const filename = uniqueZipFileName(result.filename, usedNames);
      await fs.writeFile(path.join(zipDir, filename), result.data);
    }

    await packagePass(zipDir, zipPath);
    const data = await fs.readFile(zipPath);
    const session = readSession(req);
    await audit("bulk_passes_generated", {
      username: session ? session.username : null,
      count: rows.length,
      passStyle: stringValue(template.pass && template.pass.passStyle, "generic")
    }, req);

    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="wallet-passes.zip"`,
      "content-length": data.length,
      "cache-control": "no-store"
    });
    res.end(data);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function makeDefaultPassPng(width, height, hexColor) {
  const bg = parseHexColor(hexColor, "#1d4ed8");
  const image = Buffer.alloc(width * height * 4);
  const border = Math.max(2, Math.round(width * 0.08));
  const notch = Math.max(3, Math.round(width * 0.18));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      image[index] = bg.r;
      image[index + 1] = bg.g;
      image[index + 2] = bg.b;
      image[index + 3] = 255;

      const inBorder = x < border || y < border || x >= width - border || y >= height - border;
      const inStripe = Math.abs(x - y) < Math.max(1, Math.round(width * 0.04));
      const inNotch = y > height / 2 - notch / 2 && y < height / 2 + notch / 2 && (x < notch || x > width - notch);
      if ((inBorder || inStripe) && !inNotch) {
        image[index] = 255;
        image[index + 1] = 255;
        image[index + 2] = 255;
        image[index + 3] = 230;
      }
    }
  }

  return encodePng(width, height, image);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        storage: DATABASE_URL ? "postgres" : "file"
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      await handleRegister(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/password-reset") {
      await handlePasswordResetRequest(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/logout") {
      sendRedirect(res, "/login", {
        "set-cookie": expiredSessionCookie(req)
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/login" || url.pathname === "/login.html")) {
      if (isAuthenticated(req)) {
        sendRedirect(res, "/");
        return;
      }
      await serveLogin(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin") {
      const session = readSession(req);
      if (!session) {
        sendRedirect(res, "/login");
        return;
      }
      if (session.role !== "admin") {
        sendErrorPage(res, 403, "Access Denied", "Admin access is required for this page.");
        return;
      }
      await serveAdmin(req, res);
      return;
    }

    if (req.method === "GET" && PUBLIC_ASSETS.has(url.pathname)) {
      await serveStatic(req, res);
      return;
    }

    if (!isAuthenticated(req)) {
      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 401, { error: "Sign in to generate passes." });
        return;
      }
      await serveLogin(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      await handleMe(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/state") {
      await handleAdminState(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/approve") {
      await handleApproveUser(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/reject") {
      await handleRejectUser(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/delete") {
      await handleDeleteUser(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/password-resets/approve") {
      await handleApproveReset(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/password-resets/reject") {
      await handleRejectReset(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      await handleGenerate(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate-bulk") {
      await handleGenerateBulk(req, res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    const status = error instanceof UserError ? error.status : 500;
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      sendErrorPage(
        res,
        status,
        status === 404 ? "Not Found" : "Something Went Wrong",
        error instanceof Error ? error.message : "Something went wrong."
      );
      return;
    }
    sendJson(res, status, {
      error: error instanceof Error ? error.message : "Something went wrong."
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Wallet Pass Studio running at http://${HOST}:${PORT}`);
});
