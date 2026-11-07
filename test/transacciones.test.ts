// Finanzas: crear_transaccion (finance.createTransactions) — gasto, ingreso y transferencia.
import { describe, it, expect, vi } from "vitest";
import * as W from "../src/tools/escritura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

// Cuentas financieras y categorías de ejemplo (forma de finance.getAccounts / finance.getCategories).
const cuentas = [
  { account_id: "4", name: "CAJA DE COBRO" },
  { account_id: "10", name: "TARJETA ROY" },
];
const categorias = [
  { category_id: "6", name: "Nómina" },
  { category_id: "3", name: "Ventas" },
];

/**
 * API falsa con estado. Póster GUARDA en centavos = (monto enviado en PESOS) × 100.
 * `factorMonto` = centavos que guarda Póster por cada unidad enviada:
 *   100   = correcto (pesos → centavos)
 *   10000 = bug de unidad (queda 100× más alto)
 */
function apiFinanzas(factorMonto = 100) {
  const db: Obj = {
    "finance.getAccounts": structuredClone(cuentas),
    "finance.getCategories": structuredClone(categorias),
    "finance.getTransactions": [] as Obj[],
  };
  let seq = 7000;
  const post = vi.fn(async (_c: string, metodo: string, cuerpo: Obj) => {
    if (metodo === "finance.createTransactions") {
      const id = ++seq;
      // Póster GUARDA la forma de lectura: account_id único + amount con signo (gasto negativo), category_id.
      const entra = cuerpo.amount_to !== undefined; // ingreso o destino de transferencia
      const base = Number(entra ? cuerpo.amount_to : cuerpo.amount_from);
      db["finance.getTransactions"].push({
        transaction_id: String(id),
        category_id: cuerpo.category !== undefined ? String(cuerpo.category) : "0",
        account_id: String(entra ? cuerpo.account_to : cuerpo.account_from),
        amount: String((entra ? 1 : -1) * base * factorMonto),
        date: cuerpo.date,
        comment: cuerpo.comment,
      });
      return { response: id };
    }
    return { error: 1 };
  });
  const api: PosterApi = {
    get: async (_c, m) => structuredClone(db[m]) as never,
    post: post as never,
  };
  return { api, post, db };
}
const ctx = (api: PosterApi) => ({ api, actor: "test" });

// Primer uso real: gasto de $1,806 por Fares en Helipuerto, Nómina (6), desde CAJA DE COBRO (4).
const gastoFares = (extra: Obj = {}) => ({
  cuenta: "cafe-03" as const,
  tipo: "gasto" as const,
  monto: 1806,
  account_id: 4,
  category_id: 6,
  comentario: "Pago de Fares",
  permitir_otra_cuenta: true,
  ...extra,
});

describe("crear_transaccion · dry-run", () => {
  it("gasto: arma el payload (type 0, account_from, amount_from en pesos) y NO escribe", async () => {
    const { api, post } = apiFinanzas();
    const r: any = await W.crearTransaccion(ctx(api), gastoFares());
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(r.payload.type).toBe(0); // 'type' es obligatorio en finance.createTransactions
    expect(r.payload.account_from).toBe(4);
    expect(r.payload.amount_from).toBe(1806); // en PESOS (finance.createTransactions no usa centavos)
    expect(r.payload.category).toBe(6); // Póster espera 'category', no 'category_id'
    expect(r.payload).not.toHaveProperty("category_id");
    expect(r.payload.comment).toBe("Pago de Fares");
    expect(r.payload).not.toHaveProperty("account_to");
    expect(r.payload).not.toHaveProperty("amount_to");
    // El resumen legible aparece como diff (null → despues) en `cambios`.
    expect(r.cambios.find((c: any) => c.campo === "categoria")?.despues).toBe("6 · Nómina");
    expect(r.avisos.join(" ")).toMatch(/PESOS/);
  });

  it("transferencia: account_from + account_to + ambos montos; exige destino distinto", async () => {
    const { api } = apiFinanzas();
    const r: any = await W.crearTransaccion(ctx(api), {
      cuenta: "cafe-04", tipo: "transferencia", monto: 500, account_id: 4, account_destino_id: 10,
    });
    expect(r.modo).toBe("dry-run");
    expect(r.payload.account_from).toBe(4);
    expect(r.payload.account_to).toBe(10);
    expect(r.payload.amount_from).toBe(500);
    expect(r.payload.amount_to).toBe(500);
    expect(r.payload.type).toBe(2);
    expect(r.payload).not.toHaveProperty("category");
    await expect(
      W.crearTransaccion(ctx(api), { cuenta: "cafe-04", tipo: "transferencia", monto: 500, account_id: 4, account_destino_id: 4 }),
    ).rejects.toThrow(/misma cuenta/);
  });
});

describe("crear_transaccion · validaciones", () => {
  it("rechaza escribir en una cuenta no autorizada (sin permitir_otra_cuenta)", async () => {
    const { api, post } = apiFinanzas();
    await expect(
      W.crearTransaccion(ctx(api), gastoFares({ permitir_otra_cuenta: false, confirm: true })),
    ).rejects.toThrow(/bloqueada/);
    expect(post).not.toHaveBeenCalled();
  });

  it("rechaza categoría inexistente", async () => {
    const { api, post } = apiFinanzas();
    await expect(
      W.crearTransaccion(ctx(api), { cuenta: "cafe-04", tipo: "gasto", monto: 100, account_id: 4, category_id: 999 }),
    ).rejects.toThrow(/Categoría financiera 999 no existe/);
    expect(post).not.toHaveBeenCalled();
  });

  it("rechaza cuenta financiera inexistente y gasto sin categoría", async () => {
    const { api } = apiFinanzas();
    await expect(
      W.crearTransaccion(ctx(api), { cuenta: "cafe-04", tipo: "gasto", monto: 100, account_id: 77, category_id: 6 }),
    ).rejects.toThrow(/Cuenta financiera 77 no existe/);
    await expect(
      W.crearTransaccion(ctx(api), { cuenta: "cafe-04", tipo: "gasto", monto: 100, account_id: 4 }),
    ).rejects.toThrow(/category_id es obligatorio/);
  });
});

describe("crear_transaccion · aplicar y verificar", () => {
  it("escritura correcta: aplica, relee la transacción del día y verifica monto/cuenta/categoría", async () => {
    const { api, post } = apiFinanzas(100);
    const r: any = await W.crearTransaccion(ctx(api), gastoFares({ confirm: true }));
    expect(post).toHaveBeenCalledOnce();
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.monto_leido_pesos).toBe(1806);
    expect(r.verificacion.detalle.categoria_leida).toBe(6);
    expect(r.verificacion.detalle.cuenta_leida).toBe(4);
    expect(r.verificacion.detalle).not.toHaveProperty("alerta_100x");
  });

  it("detecta la desviación 100× cuando Póster trata el monto como pesos", async () => {
    const { api } = apiFinanzas(10000);
    const r: any = await W.crearTransaccion(ctx(api), gastoFares({ confirm: true }));
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.monto_leido_pesos).toBe(180600); // 100× el esperado
    expect(r.verificacion.detalle.alerta_100x).toMatch(/100×|100 veces/);
    expect(r.verificacion.detalle.alerta_100x).toMatch(/NO repitas/);
  });

  it("avisa si no encuentra la transacción al releer", async () => {
    const { api, db } = apiFinanzas(100);
    // getTransactions vacío: la verificación no debe encontrar la transacción recién creada.
    const api2: PosterApi = { ...api, get: async (c, m, p) => (m === "finance.getTransactions" ? ([] as never) : api.get(c, m, p)) };
    void db;
    const r: any = await W.crearTransaccion(ctx(api2), gastoFares({ confirm: true }));
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.alerta).toMatch(/No se encontró/);
  });
});
