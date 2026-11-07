// Autenticación del MCP.
//   1. Bearer estático (MCP_BEARER_TOKEN) → para Claude Code, curl y pruebas.
//   2. OAuth 2.1 mínimo (DCR + authorization code + PKCE S256 + refresh) → lo que pide un conector
//      personalizado de claude.ai. Es de un solo dueño: la pantalla de autorización pide OWNER_PASSPHRASE.
//      Sin estado: client_id, code y tokens son JWT HS256 firmados con OAUTH_SIGNING_KEY
//      (rotar la llave revoca todo de golpe).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const llave = () => new TextEncoder().encode(config.oauthSigningKey);
export const oauthActivo = () => config.oauthSigningKey.length >= 32 && config.ownerPassphrase.length >= 12;

const igual = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

async function firmar(payload: Record<string, unknown>, typ: string, exp: string) {
  return new SignJWT({ ...payload, typ }).setProtectedHeader({ alg: "HS256" }).setIssuer(config.publicBaseUrl).setIssuedAt().setJti(randomUUID()).setExpirationTime(exp).sign(llave());
}
async function verificar(token: string, typ: string) {
  const { payload } = await jwtVerify(token, llave(), { issuer: config.publicBaseUrl });
  if (payload.typ !== typ) throw new Error("tipo de token inválido");
  return payload;
}

const redirectPermitido = (uri: string) => {
  if (config.oauthAllowedRedirects.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"); // MCP Inspector / pruebas locales
  } catch {
    return false;
  }
};

const resourceMetadataUrl = () => `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;

// Códigos de un solo uso y freno a fuerza bruta (por instancia, en memoria)
const codigosUsados = new Map<string, number>();
const fallos = new Map<string, { n: number; desde: number }>();
const bloqueado = (ip: string) => {
  const f = fallos.get(ip);
  return !!f && Date.now() - f.desde < 15 * 60_000 && f.n >= 5;
};
const registrarFallo = (ip: string) => {
  const f = fallos.get(ip);
  if (!f || Date.now() - f.desde > 15 * 60_000) fallos.set(ip, { n: 1, desde: Date.now() });
  else f.n++;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ipDe = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

function pagina(campos: Record<string, string>, error = "") {
  const ocultos = Object.entries(campos).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>poster-rush · autorizar</title><style>
body{font-family:system-ui,sans-serif;background:#f6f3ee;color:#1d1b18;margin:0;display:grid;place-items:center;min-height:100vh}
form{background:#fff;padding:28px 22px;border-radius:14px;max-width:360px;width:calc(100% - 32px);box-shadow:0 2px 12px #0001}
h1{font-size:20px;margin:0 0 6px}p{font-size:14px;color:#5b554c;margin:0 0 18px}
input[type=password]{width:100%;box-sizing:border-box;font-size:17px;padding:12px;border:1px solid #cfc7bb;border-radius:9px}
button{margin-top:14px;width:100%;font-size:17px;padding:12px;border:0;border-radius:9px;background:#1d1b18;color:#fff}
.err{color:#b3261e;font-size:14px;margin-top:10px}</style></head><body>
<form method="post" action="/authorize">${ocultos}
<h1>Conectar poster-rush</h1><p>Un cliente (${esc(campos.client_name || "claude.ai")}) pide acceso a las cuentas Póster de la red RUSH.</p>
<input type="password" name="passphrase" placeholder="Frase de acceso" autocomplete="current-password" required autofocus>
<button type="submit">Autorizar</button>${error ? `<div class="err">${esc(error)}</div>` : ""}</form></body></html>`;
}

export function rutasOAuth() {
  const r = new Hono();

  const prm = (c: Context) =>
    c.json({ resource: `${config.publicBaseUrl}/mcp`, authorization_servers: [config.publicBaseUrl], bearer_methods_supported: ["header"], scopes_supported: ["poster"] });
  r.get("/.well-known/oauth-protected-resource", prm);
  r.get("/.well-known/oauth-protected-resource/mcp", prm);
  r.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/authorize`,
      token_endpoint: `${config.publicBaseUrl}/token`,
      registration_endpoint: `${config.publicBaseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["poster"],
    }),
  );

  // Registro dinámico de clientes (RFC 7591): el client_id ES un JWT con sus redirect_uris
  r.post("/register", async (c) => {
    if (!oauthActivo()) return c.json({ error: "oauth_disabled" }, 503);
    const b = await c.req.json().catch(() => ({}));
    const uris: string[] = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || !uris.every(redirectPermitido)) return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uri no permitido" }, 400);
    const nombre = String(b.client_name ?? "cliente").slice(0, 60);
    const client_id = await firmar({ ru: uris, n: nombre }, "client", "3650d");
    return c.json({ client_id, client_name: nombre, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
  });

  const validarSolicitud = async (q: Record<string, string>) => {
    if (q.response_type !== "code") throw new Error("response_type debe ser code");
    if (q.code_challenge_method !== "S256" || !q.code_challenge) throw new Error("Se requiere PKCE S256");
    const cli = await verificar(q.client_id ?? "", "client");
    if (!(cli.ru as string[]).includes(q.redirect_uri)) throw new Error("redirect_uri no registrado para este cliente");
    return cli;
  };

  r.get("/authorize", async (c) => {
    if (!oauthActivo()) return c.text("OAuth deshabilitado", 503);
    const q = c.req.query();
    try {
      const cli = await validarSolicitud(q);
      const campos = { response_type: q.response_type, client_id: q.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, code_challenge_method: q.code_challenge_method, state: q.state ?? "", scope: q.scope ?? "", resource: q.resource ?? "", client_name: String(cli.n ?? "") };
      return c.html(pagina(campos));
    } catch (e) {
      return c.text(`Solicitud inválida: ${(e as Error).message}`, 400);
    }
  });

  r.post("/authorize", async (c) => {
    if (!oauthActivo()) return c.text("OAuth deshabilitado", 503);
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    const ip = ipDe(c);
    try {
      await validarSolicitud(f);
    } catch (e) {
      return c.text(`Solicitud inválida: ${(e as Error).message}`, 400);
    }
    if (bloqueado(ip)) return c.html(pagina(f, "Demasiados intentos. Espera 15 minutos."), 429);
    if (!igual(f.passphrase ?? "", config.ownerPassphrase)) {
      registrarFallo(ip);
      console.log(JSON.stringify({ severity: "WARNING", auth: "passphrase_incorrecta", ip }));
      return c.html(pagina(f, "Frase incorrecta."), 401);
    }
    fallos.delete(ip);
    const code = await firmar({ cid: createHash("sha256").update(f.client_id).digest("hex"), ru: f.redirect_uri, cc: f.code_challenge }, "code", "5m");
    const destino = new URL(f.redirect_uri);
    destino.searchParams.set("code", code);
    if (f.state) destino.searchParams.set("state", f.state);
    console.log(JSON.stringify({ severity: "NOTICE", auth: "autorizado", cliente: f.client_name, ip }));
    return c.redirect(destino.toString(), 302);
  });

  const emitir = async (cidHash: string) => ({
    access_token: await firmar({ sub: "roy", cid: cidHash }, "access", "1h"),
    refresh_token: await firmar({ sub: "roy", cid: cidHash }, "refresh", "30d"),
    token_type: "Bearer",
    expires_in: 3600,
    scope: "poster",
  });

  r.post("/token", async (c) => {
    if (!oauthActivo()) return c.json({ error: "oauth_disabled" }, 503);
    const tipo = c.req.header("content-type") ?? "";
    const b: Record<string, string> = tipo.includes("json") ? await c.req.json() : Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try {
      if (b.grant_type === "authorization_code") {
        const p = await verificar(b.code ?? "", "code");
        if (codigosUsados.has(p.jti!)) throw new Error("código ya usado");
        const cidHash = createHash("sha256").update(b.client_id ?? "").digest("hex");
        if (p.cid !== cidHash || p.ru !== b.redirect_uri) throw new Error("client_id/redirect_uri no coinciden");
        const reto = createHash("sha256").update(b.code_verifier ?? "").digest("base64url");
        if (reto !== p.cc) throw new Error("PKCE inválido");
        codigosUsados.set(p.jti!, Date.now());
        for (const [k, t] of codigosUsados) if (Date.now() - t > 10 * 60_000) codigosUsados.delete(k);
        return c.json(await emitir(cidHash));
      }
      if (b.grant_type === "refresh_token") {
        const p = await verificar(b.refresh_token ?? "", "refresh");
        return c.json(await emitir(String(p.cid)));
      }
      return c.json({ error: "unsupported_grant_type" }, 400);
    } catch (e) {
      return c.json({ error: "invalid_grant", error_description: (e as Error).message }, 400);
    }
  });

  return r;
}

/** Middleware de /mcp: deja pasar bearer estático u OAuth access token; si no, 401 con metadata. */
export const exigirAuth: MiddlewareHandler<{ Variables: { auth: AuthInfo } }> = async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  const negar = () => {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl()}"`);
    return c.json({ error: "unauthorized" }, 401);
  };
  if (!token) return negar();
  if (config.bearerToken && config.bearerToken.length >= 32 && igual(token, config.bearerToken)) {
    c.set("auth", { token: "bearer", clientId: "bearer-estatico", scopes: ["poster"], extra: { sub: "bearer" } });
    return next();
  }
  if (oauthActivo()) {
    try {
      const p = await verificar(token, "access");
      c.set("auth", { token: "oauth", clientId: String(p.cid).slice(0, 12), scopes: ["poster"], expiresAt: p.exp, extra: { sub: String(p.sub) } });
      return next();
    } catch {
      /* cae a 401 */
    }
  }
  return negar();
};
