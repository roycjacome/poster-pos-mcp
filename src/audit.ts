// Auditoría de escrituras: quién, cuándo, cuenta, método, payload (sin token) y resultado.
// Cada evento va (1) a stdout como JSON → Cloud Logging lo conserva en producción y
// (2) a un JSONL local por día en AUDIT_DIR (en Cloud Run es efímero; la fuente de verdad es Logging).
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { redactar } from "./tokens.js";

export interface EventoAuditoria {
  ts: string;
  actor: string;
  cliente?: string;
  cuenta: string;
  metodo: string;
  herramienta: string;
  modo: "dry-run" | "aplicado" | "rechazado";
  payload: unknown;
  resultado?: unknown;
  error?: string;
}

export function auditar(e: Omit<EventoAuditoria, "ts">): EventoAuditoria {
  const ev: EventoAuditoria = { ts: new Date().toISOString(), ...e };
  const linea = redactar(JSON.stringify(ev));
  console.log(JSON.stringify({ severity: e.modo === "aplicado" ? "NOTICE" : "INFO", audit: true, ...JSON.parse(linea) }));
  try {
    mkdirSync(config.auditDir, { recursive: true });
    appendFileSync(path.join(config.auditDir, `${ev.ts.slice(0, 10)}.jsonl`), linea + "\n");
  } catch {
    /* disco de solo lectura: queda el log en stdout */
  }
  return ev;
}

export function auditoriaReciente(limite = 20): EventoAuditoria[] {
  if (!existsSync(config.auditDir)) return [];
  const archivos = readdirSync(config.auditDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const out: EventoAuditoria[] = [];
  for (const f of archivos) {
    const lineas = readFileSync(path.join(config.auditDir, f), "utf8").trim().split("\n").filter(Boolean).reverse();
    for (const l of lineas) {
      out.push(JSON.parse(l));
      if (out.length >= limite) return out;
    }
  }
  return out;
}
