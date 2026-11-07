// Cliente HTTP mínimo de la API Póster: https://<cuenta>.joinposter.com/api/<metodo>?token=
import { tokenDe, redactar } from "./tokens.js";

export type PosterRespuesta<T = unknown> = { response?: T; success?: number; error?: unknown; message?: string };

export interface PosterApi {
  get<T = unknown>(cuenta: string, metodo: string, params?: Record<string, string | number>): Promise<T>;
  post<T = unknown>(cuenta: string, metodo: string, cuerpo: unknown, opciones?: { form?: boolean }): Promise<PosterRespuesta<T>>;
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METODO_OK = /^[a-zA-Z]+\.[a-zA-Z0-9]+$/;

async function pedir(url: string, init: RequestInit, intentos: number): Promise<PosterRespuesta> {
  let ultimo = "";
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      const t = await r.text();
      // Póster a veces devuelve HTML de error/limitación: se reintenta
      if (t.trim().startsWith("{") || t.trim().startsWith("[")) return JSON.parse(t);
      ultimo = `HTTP ${r.status}: ${t.slice(0, 120)}`;
    } catch (e) {
      ultimo = String((e as Error).message ?? e);
    }
    await espera(800 * (i + 1));
  }
  throw new Error(redactar(`Póster sin respuesta JSON: ${ultimo}`));
}

export function errorPoster(r: PosterRespuesta): string | null {
  if (r.error !== undefined && r.error !== null && r.error !== 0) return redactar(JSON.stringify(r).slice(0, 300));
  return null;
}

export const posterHttp: PosterApi = {
  async get(cuenta, metodo, params = {}) {
    if (!METODO_OK.test(metodo)) throw new Error(`Método inválido: ${metodo}`);
    const token = await tokenDe(cuenta);
    const qs = new URLSearchParams({ format: "json", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    const r = await pedir(`https://${cuenta}.joinposter.com/api/${metodo}?token=${encodeURIComponent(token)}&${qs}`, {}, 5);
    const e = errorPoster(r);
    if (e) throw new Error(`${metodo}: ${e}`);
    return r.response as never;
  },
  async post(cuenta, metodo, cuerpo, opciones = {}) {
    if (!METODO_OK.test(metodo)) throw new Error(`Método inválido: ${metodo}`);
    const token = await tokenDe(cuenta);
    const url = `https://${cuenta}.joinposter.com/api/${metodo}?token=${encodeURIComponent(token)}`;
    let init: RequestInit;
    if (opciones.form) {
      const f = new FormData();
      for (const [k, v] of Object.entries(cuerpo as Record<string, unknown>)) f.append(k, typeof v === "string" ? v : JSON.stringify(v));
      init = { method: "POST", body: f };
    } else {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) };
    }
    // Escrituras: un solo intento por si Póster sí aplicó y solo tardó en responder (evita duplicados)
    return (await pedir(url, init, 1)) as never;
  },
};
