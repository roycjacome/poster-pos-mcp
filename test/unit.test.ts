import { describe, it, expect, vi } from "vitest";
import { pesos, centavos, promoVigente, diff } from "../src/util.js";
import { verificarEscritura } from "../src/config.js";
import * as W from "../src/tools/escritura.js";
import type { PosterApi } from "../src/poster.js";

// Platillo de ejemplo con la forma real de menu.getProducts (cafe-04, Americano 271)
const americano = () => ({
  product_id: "271", product_name: "Americano", menu_category_id: "8", category_name: "Calientes con café", type: "2",
  workshop: "1", color: "red", weight_flag: "0", out: 0, price: { "1": "0" },
  spots: [{ spot_id: "1", price: "0", visible: "1" }],
  group_modifications: [{ name: "Tamaño Americano", num_min: 1, num_max: 1, type: 1, modifications: [
    { dish_modification_id: 7050, name: "● CH 12 oz", ingredient_id: 100, type: 2, brutto: 1, price: 55, sort_order: 1 },
    { dish_modification_id: 7051, name: "●● MD 16 oz", ingredient_id: 102, type: 2, brutto: 1, price: 65, sort_order: 2 },
  ] }],
  ingredients: [],
});

function apiFalsa(datos: Record<string, unknown>) {
  const post = vi.fn(async () => ({ response: 1 }));
  const api: PosterApi = { get: async (_c, m) => structuredClone(datos[m]) as never, post: post as never };
  return { api, post };
}
const ctx = (api: PosterApi) => ({ api, actor: "test" });

describe("utilidades", () => {
  it("convierte importes", () => {
    expect(pesos("519000")).toBe(5190);
    expect(centavos(20)).toBe(2000);
    expect(centavos(0.555)).toBe(56);
  });
  it("promoción vigente con 0000-00-00 o fecha futura", () => {
    expect(promoVigente("0000-00-00 00:00:00", "2026-10-16")).toBe(true);
    expect(promoVigente("2026-10-16 23:59:00", "2026-10-16")).toBe(true);
    expect(promoVigente("2026-10-15 23:59:00", "2026-10-16")).toBe(false);
  });
  it("diff anidado", () => {
    expect(diff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toEqual([{ campo: "b.c", antes: 2, despues: 3 }]);
  });
});

describe("guardas de escritura", () => {
  it("cafe-04 se escribe por defecto", () => expect(() => verificarEscritura("cafe-04", false)).not.toThrow());
  it("otra cuenta exige flag", () => {
    expect(() => verificarEscritura("cafe-02", false)).toThrow(/bloqueada/);
    expect(() => verificarEscritura("cafe-02", true)).not.toThrow();
  });
  it("cuenta fuera de lista blanca siempre falla", () => expect(() => verificarEscritura("otra-cuenta", true)).toThrow(/lista blanca/));
});

describe("contrato updateDish", () => {
  it("reenvía todo; opción leída en pesos se escribe en centavos; visible de spots", () => {
    const p = W.payloadUpdateDish(americano());
    expect(p.price).toEqual({ "1": 0 });
    expect(p.visible).toEqual({ "1": 1 });
    expect(p["ingredient[]"]).toEqual([]);
    expect(p.modificationgroup[0].modifications.map((m: any) => m.price)).toEqual([5500, 6500]);
  });

  it("dry-run de ocultar: devuelve diff y NO escribe", async () => {
    const { api, post } = apiFalsa({ "menu.getProducts": [americano()] });
    const r: any = await W.actualizarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 271, visible: false });
    expect(r.modo).toBe("dry-run");
    expect(r.cambios).toEqual([{ campo: "visible.1", antes: 1, despues: 0 }]);
    expect(post).not.toHaveBeenCalled();
  });

  it("precio de opción: pesos → centavos en el diff", async () => {
    const { api } = apiFalsa({ "menu.getProducts": [americano()] });
    const r: any = await W.actualizarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 271, precios_opciones: [{ dish_modification_id: 7051, precio: 70 }] });
    expect(r.cambios).toEqual([{ campo: "modificationgroup.0.modifications.1.price", antes: 6500, despues: 7000 }]);
  });

  it("rechaza platillo con receta (updateDish la borraría)", async () => {
    const p = { ...americano(), ingredients: [{ ingredient_id: "60", structure_brutto: "100" }] };
    const { api, post } = apiFalsa({ "menu.getProducts": [p] });
    await expect(W.actualizarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 271, visible: false, confirm: true })).rejects.toThrow(/tiene receta/);
    expect(post).not.toHaveBeenCalled();
  });

  it("otra cuenta sin flag no llega ni a leer", async () => {
    const { api, post } = apiFalsa({ "menu.getProducts": [americano()] });
    await expect(W.actualizarPlatillo(ctx(api), { cuenta: "cafe-02", product_id: 271, visible: false, confirm: true })).rejects.toThrow(/bloqueada/);
    expect(post).not.toHaveBeenCalled();
  });

  it("confirm:true aplica y verifica leyendo de vuelta", async () => {
    const { api, post } = apiFalsa({ "menu.getProducts": [americano()] });
    const r: any = await W.actualizarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 271, precio: 0, confirm: true });
    expect(post).toHaveBeenCalledOnce();
    const cuerpo: any = (post.mock.calls[0] as unknown[])[2];
    expect(cuerpo.modificationgroup[0].modifications[0]).not.toHaveProperty("_id");
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
  });
});

describe("otros dry-run", () => {
  it("crear_compra arma multipart con sum en centavos por unidad", async () => {
    const { api, post } = apiFalsa({
      "storage.getStorages": [{ storage_id: "1", storage_name: "Inventory count" }],
      "storage.getSuppliers": [{ supplier_id: "4", supplier_name: "Rush Periferica" }],
      "menu.getIngredients": [{ ingredient_id: 277, ingredient_name: "Bolsa 1/4", ingredient_unit: "p" }],
      "storage.getSupplies": [],
    });
    const r: any = await W.crearCompra(ctx(api), { cuenta: "cafe-04", storage_id: 1, supplier_id: 4, comentario: "Ticket X", renglones: [{ id: 277, cantidad: 10, costo_unitario: 104 }] });
    expect(r.modo).toBe("dry-run");
    expect(r.payload.ingredients).toEqual([{ id: 277, type: 4, num: 10, sum: 10400 }]);
    expect(r.cambios.find((c: any) => c.campo === "total_pesos").despues).toBe(1040);
    expect(post).not.toHaveBeenCalled();
  });

  it("crear_insumo rechaza duplicado por nombre normalizado", async () => {
    const { api } = apiFalsa({ "menu.getIngredients": [{ ingredient_id: 1, ingredient_name: "Limón" }], "menu.getCategoriesIngredients": [{ category_id: 1, name: "barra" }] });
    await expect(W.crearInsumo(ctx(api), { cuenta: "cafe-04", nombre: "limon", categoria_id: 1, unidad: "kg" })).rejects.toThrow(/Ya existe/);
  });

  it("actualizar_precocinado conserva receta y cambia rendimiento", async () => {
    const pp = [{ product_id: "37", product_name: "Cold Brew", unit: "kg", out: 2000, ingredients: [
      { ingredient_id: "97", structure_type: "1", structure_brutto: "250", structure_netto: 250, structure_unit: "g", structure_lock: "1" },
    ] }];
    const { api } = apiFalsa({ "menu.getPrepacks": pp, "menu.getIngredients": [{ ingredient_id: 97 }] });
    const r: any = await W.actualizarPrecocinado(ctx(api), { cuenta: "cafe-04", product_id: 37, rendimiento: 2250 });
    expect(r.cambios).toEqual([{ campo: "out", antes: 2000, despues: 2250 }]);
    expect(r.payload.ingredient).toEqual([{ id: 97, type: 1, brutto: 250, netto: 250, lock: 1, unit: "g" }]);
  });
});
