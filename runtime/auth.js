const crypto = require("crypto");

const COOKIE_NAME = "agent_session";
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const sessions = new Map();

function configured() {
  return Boolean(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD);
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cookieFlags() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Strict${secure}`;
}

function issueSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isAuthenticated(req) {
  if (!configured()) return false;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function login(req, username, password) {
  if (!configured()) {
    throw new Error("Authentication is not configured.");
  }

  if (!timingSafeEqual(username, process.env.AUTH_USERNAME) ||
      !timingSafeEqual(password, process.env.AUTH_PASSWORD)) {
    return false;
  }

  const token = issueSession();
  req.res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ${cookieFlags()}`
  );
  return true;
}

function logout(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) sessions.delete(token);
  req.res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Max-Age=0; ${cookieFlags()}`
  );
}

function requireAuth(req, res, next) {
  if (!configured()) {
    return res.status(503).json({
      error: "Authentication is not configured. Set AUTH_USERNAME and AUTH_PASSWORD."
    });
  }

  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "Authentication required." });
  }

  next();
}

module.exports = {
  configured,
  isAuthenticated,
  login,
  logout,
  requireAuth
};
