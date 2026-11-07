// Compras y su pago: account_id en crear_compra + asignar_pago_compra (el botón "pagar" de Póster).
import { describe, it, expect, vi } from "vitest";
import * as W from "../src/tools/escritura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const cuentasFin = [
  { account_id: "3", name: "Caja de cobro Periferica" },
  { account_id: "4", name: "Periferica Compras Tarjeta inbursa 9848" },
];

/** Compra 2606 (Bruné, a crédito = account_id ""), como la lee storage.getSupply (importes en pesos). */
const compra2606 = (): Obj => ({
  supply_id: 2606, in_inventory: 0, storage_id: 3, supplier_id: 98, account_id: "",
  date: "2026-10-24 01:09:30", supply_sum: "325.00", supply_sum_netto: "325.00", supply_comment: "", supplier_name: "Bruné Bakery",
  ingredients: [{ ingredient_id: 662, supply_ingredient_num: 5, supply_ingredient_sum: "325.00", ingredient_name: "Tarta Vasca", ingredient_unit: "p", type: 1 }],
});

/** API falsa con estado. `updateSetea` controla si storage.updateSupply realmente fija account_id (para probar la verificación). */
function apiCompras(opts: { supply?: Obj; updateSetea?: boolean } = {}) {
  const updateSetea = opts.updateSetea ?? true;
  const supplies: Record<number, Obj> = {};
  const s = opts.supply ?? compra2606();
  supplies[num(s.supply_id)] = s;
  const db: Obj = {
    "storage.getStorages": [{ storage_id: "3", storage_name: "Barra Periferica", delete: "0" }],
    "storage.getSuppliers": [{ supplier_id: "98", supplier_name: "Bruné Bakery", delete: "0" }],
    "menu.getIngredients": [{ ingredient_id: "662", ingredient_name: "Tarta Vasca", ingredient_unit: "p" }],
    "storage.getSupplies": [],
    "finance.getAccounts": structuredClone(cuentasFin),
  };
  const post = vi.fn(async (_c: string, metodo: string, cuerpo: Obj) => {
    if (metodo === "storage.createSupply") return { response: 3000 };
    if (metodo === "storage.updateSupply") {
      const sup = supplies[num(cuerpo.supply_id)];
      if (sup && updateSetea) sup.account_id = cuerpo.account_id; // total y renglones intactos
      return { response: true };
    }
    return { error: 1 };
  });
  const api: PosterApi = {
    get: async (_c, m, params) => (m === "storage.getSupply" ? (structuredClone(supplies[Number(params?.supply_id)]) as never) : (structuredClone(db[m]) as never)),
    post: post as never,
  };
  return { api, post, supplies };
}
const num = (v: unknown) => Number(v);
const ctx = (api: PosterApi) => ({ api, actor: "test" });

describe("crear_compra · account_id", () => {
  const compra = (extra: Obj = {}) => ({
    cuenta: "cafe-04" as const, storage_id: 3, supplier_id: 98,
    renglones: [{ id: 662, tipo: "producto" as const, cantidad: 5, costo_unitario: 65 }],
    ...extra,
  });
  it("con account_id: lo mete al payload y valida que exista", async () => {
    const { api, post } = apiCompras();
    const r: any = await W.crearCompra(ctx(api), compra({ account_id: 4 }));
    expect(r.modo).toBe("dry-run");
    expect(r.payload.account_id).toBe(4);
    expect(post).not.toHaveBeenCalled();
  });
  it("sin account_id: no lo manda y avisa que queda a crédito", async () => {
    const { api } = apiCompras();
    const r: any = await W.crearCompra(ctx(api), compra());
    expect(r.payload).not.toHaveProperty("account_id");
    expect(r.avisos.join(" ")).toMatch(/crédito/);
  });
  it("rechaza account_id inexistente", async () => {
    const { api } = apiCompras();
    await expect(W.crearCompra(ctx(api), compra({ account_id: 999 }))).rejects.toThrow(/Cuenta financiera 999 no existe/);
  });
});

describe("asignar_pago_compra", () => {
  it("dry-run: arma updateSupply con la cuenta nueva y NO escribe", async () => {
    const { api, post } = apiCompras();
    const r: any = await W.asignarPagoCompra(ctx(api), { cuenta: "cafe-04", supply_id: 2606, account_id: 4 });
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(r.payload.supply_id).toBe(2606);
    expect(r.payload.account_id).toBe(4);
    // Reconstrucción del renglón: 325 pesos / 5 = $65 → 6500 centavos por unidad
    expect(r.payload.ingredients).toEqual([{ id: 662, type: 1, num: 5, sum: 6500 }]);
  });
  it("rechaza cuenta o compra inexistente", async () => {
    const { api } = apiCompras();
    await expect(W.asignarPagoCompra(ctx(api), { cuenta: "cafe-04", supply_id: 2606, account_id: 999 })).rejects.toThrow(/Cuenta financiera 999 no existe/);
    await expect(W.asignarPagoCompra(ctx(api), { cuenta: "cafe-04", supply_id: 9999, account_id: 4 })).rejects.toThrow(/Compra 9999 no existe/);
  });
  it("rechaza si ya está pagada con esa misma cuenta", async () => {
    const pagada = { ...compra2606(), account_id: "4" };
    const { api } = apiCompras({ supply: pagada });
    await expect(W.asignarPagoCompra(ctx(api), { cuenta: "cafe-04", supply_id: 2606, account_id: 4 })).rejects.toThrow(/ya está pagada/);
  });
  it("confirm: asigna la cuenta, relee y verifica total y renglones intactos", async () => {
    const { api, post } = apiCompras();
    const r: any = await W.asignarPagoCompra(ctx(api), { cuenta: "cafe-04", supply_id: 2606, account_id: 4, confirm: true });
    expect(post).toHaveBeenCalledOnce();
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.cuenta_pago_leida).toBe(4);
    expect(r.verificacion.detalle.total_leido_pesos).toBe(325);
  });
  it("detecta si la cuenta no quedó asignada tras escribir", async () => {
    const { api } = apiCompras({ updateSetea: false });
    const r: any = await W.asignarPagoCompra(ctx(api), { cuenta: "cafe-04", supply_id: 2606, account_id: 4, confirm: true });
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.alerta_cuenta).toMatch(/no quedó asignada/);
  });
  it("otra cuenta (tenant) sin permitir_otra_cuenta queda bloqueada", async () => {
    const { api, post } = apiCompras();
    await expect(W.asignarPagoCompra(ctx(api), { cuenta: "cafe-02", supply_id: 2606, account_id: 4, confirm: true })).rejects.toThrow(/bloqueada/);
    expect(post).not.toHaveBeenCalled();
  });
});
