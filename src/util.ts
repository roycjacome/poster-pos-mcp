// Utilidades puras (sin red): conversión de importes, normalización y diff. Se prueban sin Póster.

export const num = (v: unknown, def = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
/** Centavos → pesos con 2 decimales. */
export const pesos = (centavos: unknown) => Math.round(num(centavos)) / 100;
/** Pesos → centavos enteros. */
export const centavos = (p: unknown) => Math.round(num(p) * 100);

export const norm = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const coincide = (texto: unknown, buscar?: string) => !buscar || norm(texto).includes(norm(buscar));

/** Hoy en la zona de la red (Ciudad del Carmen = America/Merida), YYYY-MM-DD. */
export const hoyMx = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Merida" });

/** Promoción vigente: date_end vacío/0000-00-00 o ≥ hoy. */
export function promoVigente(dateEnd: unknown, hoy = hoyMx()): boolean {
  const s = String(dateEnd ?? "").trim();
  if (!s || s.startsWith("0000-00-00")) return true;
  return s.slice(0, 10) >= hoy;
}

/** Fecha YYYY-MM-DD → YYYYMMDD (formato de filtros de Póster). */
export const fechaPoster = (iso: string) => iso.replace(/-/g, "").slice(0, 8);

export interface Cambio {
  campo: string;
  antes: unknown;
  despues: unknown;
}

/** Diff profundo y legible entre dos valores JSON-serializables. */
export function diff(antes: unknown, despues: unknown, ruta = ""): Cambio[] {
  if (JSON.stringify(antes) === JSON.stringify(despues)) return [];
  const esObj = (x: unknown) => x !== null && typeof x === "object";
  if (esObj(antes) && esObj(despues) && Array.isArray(antes) === Array.isArray(despues)) {
    const a = antes as Record<string, unknown>, d = despues as Record<string, unknown>;
    const llaves = [...new Set([...Object.keys(a), ...Object.keys(d)])];
    return llaves.flatMap((k) => diff(a[k], d[k], ruta ? `${ruta}.${k}` : k));
  }
  return [{ campo: ruta || "(raíz)", antes, despues }];
}

/** Unidad de un renglón de receta de precocinado: Póster lee kg/l pero escribe g/ml. */
export const unidadReceta = (u: string) => (u === "kg" ? "g" : u === "l" ? "ml" : u);
