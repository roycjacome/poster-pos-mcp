// Flujo HTTP completo: 401 sin token, bearer estático, y OAuth (DCR → authorize → token) hasta tools/list.
import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";

let app: { request: (input: string, init?: RequestInit) => Promise<Response> };
const BEARER = "b".repeat(64);
const FRASE = "frase-de-prueba-larga";

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN = BEARER;
  process.env.OAUTH_SIGNING_KEY = "k".repeat(64);
  process.env.OWNER_PASSPHRASE = FRASE;
  const { crearApp } = await import("../src/server.js");
  app = crearApp();
});

const rpc = (token: string, method: string, params: object = {}) =>
  app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

describe("auth del MCP", () => {
  it("sin token → 401 con resource_metadata", async () => {
    const r = await app.request("/mcp", { method: "POST" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("bearer estático lista herramientas", async () => {
    const r = await rpc(BEARER, "tools/list");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    const nombres = j.result.tools.map((t: any) => t.name);
    expect(nombres).toEqual(expect.arrayContaining(["menu_snapshot", "compras", "saldos", "actualizar_platillo", "crear_compra", "actualizar_precocinado", "crear_categoria", "crear_precocinado", "crear_platillo", "ocultar_platillo", "borrar_platillo_old", "actualizar_receta_platillo"]));
  });

  it("OAuth completo con PKCE", async () => {
    const meta: any = await (await app.request("/.well-known/oauth-authorization-server")).json();
    expect(meta.code_challenge_methods_supported).toContain("S256");
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg: any = await (await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "claude" }) })).json();
    expect(reg.client_id).toBeTruthy();

    const malo = await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
    expect(malo.status).toBe(400);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
    expect((await app.request(`/authorize?${q}`)).status).toBe(200);

    const mal = await app.request("/authorize", { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(q), passphrase: "nope" }) });
    expect(mal.status).toBe(401);

    const ok = await app.request("/authorize", { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(q), passphrase: FRASE }) });
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;

    const tok: any = await (await app.request("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }) })).json();
    expect(tok.access_token).toBeTruthy();
    // el código es de un solo uso
    const otra = await app.request("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }) });
    expect(otra.status).toBe(400);

    expect((await rpc(tok.access_token, "tools/list")).status).toBe(200);
    const ref: any = await (await app.request("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }) })).json();
    expect((await rpc(ref.access_token, "tools/list")).status).toBe(200);
    // un refresh token no sirve como access token
    expect((await rpc(tok.refresh_token, "tools/list")).status).toBe(401);
  });
});
