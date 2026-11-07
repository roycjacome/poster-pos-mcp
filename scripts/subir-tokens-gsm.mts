// Sube los tokens Póster de la DB local (poster_accounts) a Google Secret Manager.
// NUNCA imprime tokens: los pasa por stdin a `gcloud`.
//   Simulación (default): npx tsx scripts/subir-tokens-gsm.mts --project <ID>
//   Aplicar:              npx tsx scripts/subir-tokens-gsm.mts --project <ID> --confirm
import { spawnSync } from "node:child_process";
process.env.TOKEN_SOURCE = "mysql";
const { CUENTAS } = await import("../src/config.js");
const { tokenDe, nombreSecreto } = await import("../src/tokens.js");

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const proyecto = arg("--project");
const confirmar = process.argv.includes("--confirm");
if (!proyecto) { console.error("Falta --project <GCP_PROJECT_ID>"); process.exit(1); }

const gcloud = (args: string[], input?: string) => spawnSync("gcloud", [...args, `--project=${proyecto}`], { input, encoding: "utf8" });

for (const cuenta of CUENTAS) {
  const nombre = nombreSecreto(cuenta);
  const token = await tokenDe(cuenta);
  const existe = gcloud(["secrets", "describe", nombre, "--format=value(name)"]).status === 0;
  if (!confirmar) { console.log(`[SIM] ${nombre} · ${existe ? "agregar versión" : "crear secreto"} · token ${token.length} chars`); continue; }
  if (!existe) {
    const c = gcloud(["secrets", "create", nombre, "--replication-policy=automatic", "--labels=app=poster-rush"]);
    if (c.status !== 0) { console.error(`✗ ${nombre}: ${c.stderr.trim()}`); continue; }
  }
  const v = gcloud(["secrets", "versions", "add", nombre, "--data-file=-"], token);
  console.log(v.status === 0 ? `✓ ${nombre}` : `✗ ${nombre}: ${v.stderr.trim()}`);
}
if (!confirmar) console.log("\nSimulación. Repite con --confirm para crear/actualizar los secretos.");
