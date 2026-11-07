// Configuración central: lista blanca de cuentas, permisos de escritura y entorno.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env local (en Cloud Run las variables llegan del servicio; no hay archivo)
function cargarDotenv(archivo: string) {
  if (!existsSync(archivo)) return;
  for (const linea of readFileSync(archivo, "utf8").split(/\r?\n/)) {
    if (!linea.includes("=") || linea.trimStart().startsWith("#")) continue;
    const k = linea.slice(0, linea.indexOf("=")).trim();
    const v = linea.slice(linea.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
cargarDotenv(path.join(RAIZ, ".env"));

/** Las 10 cuentas Póster de la red RUSH. Nada fuera de esta lista se toca, ni en lectura. */
export const CUENTAS = [
  "cafe-01",
  "cafe-02",
  "cafe-03",
  "cafe-04",
  "cafe-05",
  "cafe-06",
  "cafe-07",
  "cafe-08",
  "cafe-09",
  "cafe-10",
] as const;
export type Cuenta = (typeof CUENTAS)[number];

const env = (k: string, def = "") => process.env[k] ?? def;

export const config = {
  raiz: RAIZ,
  port: Number(env("PORT", "3210")),
  publicBaseUrl: env("PUBLIC_BASE_URL", `http://localhost:${env("PORT", "3210")}`).replace(/\/$/, ""),
  tokenSource: env("TOKEN_SOURCE", "gsm") as "gsm" | "mysql",
  finanzasEnvPath: path.resolve(RAIZ, env("FINANZAS_ENV_PATH", "../erp-core/services/finanzas-pro/.env")),
  gcpProjectId: env("GCP_PROJECT_ID"),
  secretPrefix: env("SECRET_PREFIX", "poster-token-"),
  writeDefault: new Set(env("WRITE_DEFAULT_ACCOUNTS", "cafe-04").split(",").map((s) => s.trim()).filter(Boolean)),
  bearerToken: env("MCP_BEARER_TOKEN"),
  oauthSigningKey: env("OAUTH_SIGNING_KEY"),
  ownerPassphrase: env("OWNER_PASSPHRASE"),
  oauthAllowedRedirects: env("OAUTH_ALLOWED_REDIRECTS", "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
    .split(",").map((s) => s.trim()).filter(Boolean),
  auditDir: path.resolve(RAIZ, env("AUDIT_DIR", "./audit")),
};

export function esCuenta(c: string): c is Cuenta {
  return (CUENTAS as readonly string[]).includes(c);
}

/**
 * Regla de escritura: la cuenta debe estar en la lista blanca; si no está en WRITE_DEFAULT_ACCOUNTS
 * (por defecto solo cafe-04) la llamada tiene que traer `permitir_otra_cuenta: true`.
 */
export function verificarEscritura(cuenta: string, permitirOtra: boolean | undefined): void {
  if (!esCuenta(cuenta)) throw new Error(`Cuenta "${cuenta}" fuera de la lista blanca.`);
  if (config.writeDefault.has(cuenta)) return;
  if (permitirOtra === true) return;
  throw new Error(
    `Escritura en "${cuenta}" bloqueada: solo ${[...config.writeDefault].join(", ")} se escribe por defecto. ` +
      `Para otra cuenta, Roy debe autorizarla explícitamente y la llamada debe incluir permitir_otra_cuenta: true.`,
  );
}
