// poster-rush · servidor MCP remoto (Hono + Streamable HTTP, modo sin estado).
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "./config.js";
import { crearServidorMcp } from "./mcp.js";
import { exigirAuth, oauthActivo, rutasOAuth } from "./auth.js";

export function crearApp() {
  const app = new Hono<{ Variables: { auth: AuthInfo } }>();

  app.get("/health", (c) => c.json({ ok: true, servicio: "poster-rush", tokens: config.tokenSource, oauth: oauthActivo() }));
  app.get("/", (c) => c.text("poster-rush MCP · endpoint: /mcp"));
  app.route("/", rutasOAuth());

  app.use("/mcp", exigirAuth);
  app.all("/mcp", async (c) => {
    // Sin estado: un servidor + transporte por petición (escala horizontal en Cloud Run sin sesiones pegajosas)
    const transporte = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const servidor = crearServidorMcp();
    await servidor.connect(transporte);
    try {
      return await transporte.handleRequest(c.req.raw, { authInfo: c.get("auth") });
    } finally {
      // el transporte ya armó la respuesta JSON; liberar
      void servidor.close();
    }
  });
  return app;
}

if (process.env.VITEST === undefined) {
  if (!config.bearerToken && !oauthActivo()) {
    console.error("✗ Sin autenticación configurada: define MCP_BEARER_TOKEN y/o OAUTH_SIGNING_KEY + OWNER_PASSPHRASE.");
    process.exit(1);
  }
  const srv = serve({ fetch: crearApp().fetch, port: config.port, hostname: "0.0.0.0" }, (i) =>
    console.log(`poster-rush MCP escuchando en :${i.port} · tokens=${config.tokenSource} · oauth=${oauthActivo()} · base=${config.publicBaseUrl}`),
  );
  // Anti-invasión de puertos: si el puerto está ocupado, salir (no buscar otro)
  srv.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `✗ Puerto ${config.port} ocupado. Revisa: dev doctor` : e);
    process.exit(1);
  });
}
