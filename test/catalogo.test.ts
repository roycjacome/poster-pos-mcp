// Estandarizar catálogo: actualizar_producto, crear_producto, renombrar_insumo
// y actualizar_platillo sobre platillos con receta (ej. galletas Chunky en toda la red).
import { describe, it, expect, vi } from "vitest";
import * as W from "../src/tools/catalogo.js";
import { CUENTAS } from "../src/config.js";

const C = { cuenta: CUENTAS[0] as string, permitir_otra_cuenta: true };
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

// Producto de reventa tipo 3 (forma de menu.getProducts / getProduct)
const galleta = (): Obj => ({
  product_id: "638", product_name: "Galleta Eve", menu_category_id: "3", workshop: "1", type: "3",
  color: "grey", weight_flag: "0", price: { "1": "5000" }, spots: [{ spot_id: "1", price: "5000", visible: "1" }],
});
const triple = (): Obj => ({ ...galleta(), product_id: "737", product_name: "galleta triple chocolate Eve", price: { "1": "5500" }, spots: [{ spot_id: "1", price: "5500", visible: "1" }] });
// Platillo con receta (Periférica: chispas/Macadamia)
const conReceta = (): Obj => ({
  product_id: "710", product_name: "Galleta de chispas/Macadamia", menu_category_id: "3", workshop: "1", type: "2",
  color: "grey", weight_flag: "0", out: 0, price: { "1": "5000" }, spots: [{ spot_id: "1", price: "5000", visible: "1" }],
  group_modifications: [],
  ingredients: [{ ingredient_id: "512", structure_unit: "p", structure_type: "1", structure_brutto: 1, structure_netto: 1, structure_lock: "1" }],
});

/** API falsa con estado: las escrituras mutan lo que se lee después. */
function apiConEstado(inicial: Obj, opciones: { precioEnPesos?: boolean } = {}) {
  const db = structuredClone(inicial);
  const prods = () => db["menu.getProducts"] as Obj[];
  const post = vi.fn(async (_c: string, metodo: string, b: Obj) => {
    if (metodo === "menu.updateProduct") {
      const p = prods().find((x) => Number(x.product_id) === b.id);
      if (b.modifications !== 0) return { error: 34, message: "modifications is empty" };
      p.product_name = b.product_name;
      const spots = Object.keys(p.price);
      const pr = (s: string) => (b.different_spots_prices ? b.price[s] : b.price);
      const vi = (s: string) => (b.different_spots_prices ? b.visible[s] : b.visible);
      p.price = Object.fromEntries(spots.map((s) => [s, String(opciones.precioEnPesos ? Number(pr(s)) / 100 : pr(s))]));
      p.spots = spots.map((s) => ({ spot_id: s, price: p.price[s], visible: String(vi(s)) }));
      return { response: b.id };
    }
    if (metodo === "menu.createProduct") {
      if (b.modifications !== 0) return { error: 34, message: "modifications is empty" };
      prods().push({ product_id: "900", product_name: b.product_name, menu_category_id: String(b.menu_category_id), type: "3", workshop: String(b.workshop),
        price: { "1": String(b.price) }, spots: [{ spot_id: "1", price: String(b.price), visible: String(b.visible) }] });
      return { response: 900 };
    }
    if (metodo === "menu.updateDish") {
      const p = prods().find((x) => Number(x.product_id) === b.dish_id);
      p.product_name = b.product_name;
      p.ingredients = (b.ingredient ?? []).map((l: Obj) => ({ ingredient_id: String(l.id), structure_type: String(l.type), structure_brutto: l.brutto, structure_netto: l.netto, structure_lock: "1" }));
      return { response: 1 };
    }
    if (metodo === "menu.updateIngredient") {
      const i = db["menu.getIngredients"].find((x: Obj) => Number(x.ingredient_id) === b.id);
      i.ingredient_name = b.ingredient_name;
      return { response: 1 };
    }
    if (metodo === "storage.updateSupplier") {
      const s = db["storage.getSuppliers"].find((x: Obj) => Number(x.supplier_id) === b.supplier_id);
      Object.assign(s, b, { supplier_id: String(b.supplier_id) });
      return { response: 1 };
    }
    return { error: 1, message: `no simulado: ${metodo}` };
  });
  const api: PosterApi = {
    get: async (_c, m, params) => {
      if (m === "menu.getProduct") return structuredClone(prods().find((x) => Number(x.product_id) === Number(params?.product_id))) as never;
      return structuredClone(db[m]) as never;
    },
    post: post as never,
  };
  return { api, post, db };
}
const ctx = (api: PosterApi) => ({ api, actor: "test" });
const base = () => ({
  "menu.getProducts": [galleta(), triple(), conReceta()],
  "menu.getCategories": [{ category_id: "3", category_name: "Postres" }],
  "menu.getIngredients": [{ ingredient_id: "317", ingredient_name: "Galleta Eve", category_id: "2", ingredient_unit: "p" }, { ingredient_id: "318", ingredient_name: "Leche", category_id: "1", ingredient_unit: "l" }],
  "storage.getSuppliers": [
    { supplier_id: "21", supplier_name: "GALLETAS EVE", supplier_phone: "938 000 0000", supplier_comment: "Villa Marina", delete: "0" },
    { supplier_id: "22", supplier_name: "Evelyn Zavala", delete: "0" },
  ],
});

describe("actualizar_producto (tipo 3)", () => {
  it("dry-run: renombra sin tocar precio ni visibilidad y no escribe", async () => {
    const { api, post } = apiConEstado(base());
    const r: any = await W.actualizarProducto(ctx(api), { ...C, product_id: 638, nombre: "CHUNKY CHISPAS" });
    expect(r.modo).toBe("dry-run");
    expect(r.metodo).toBe("menu.updateProduct");
    expect(r.cambios).toEqual([{ campo: "product_name", antes: "Galleta Eve", despues: "CHUNKY CHISPAS" }]);
    expect(r.payload).toMatchObject({ id: 638, modifications: 0, different_spots_prices: 0, price: 5000, visible: 1, barcode: "" });
    expect(post).not.toHaveBeenCalled();
  });

  it("aplica y verifica nombre + precio leyendo de vuelta", async () => {
    const { api } = apiConEstado(base());
    const r: any = await W.actualizarProducto(ctx(api), { ...C, product_id: 737, nombre: "CHUNKY TRIPLE CHOCO", precio: 55, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
  });

  it("marca alerta si Póster guardó el precio 100× desviado", async () => {
    const { api } = apiConEstado(base(), { precioEnPesos: true });
    const r: any = await W.actualizarProducto(ctx(api), { ...C, product_id: 638, precio: 50, confirm: true });
    expect(r.verificacion.ok).toBe(false);
    expect(JSON.stringify(r.verificacion.detalle)).toMatch(/alerta_100x/);
  });

  it("rechaza nombre duplicado y platillos tipo 2", async () => {
    const { api, post } = apiConEstado(base());
    await expect(W.actualizarProducto(ctx(api), { ...C, product_id: 638, nombre: "galleta triple chocolate eve" })).rejects.toThrow(/Ya existe/);
    await expect(W.actualizarProducto(ctx(api), { ...C, product_id: 710, nombre: "X" })).rejects.toThrow(/renombrar_platillo/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("crear_producto", () => {
  it("dry-run con precio en centavos y spots del hermano de categoría", async () => {
    const { api, post } = apiConEstado(base());
    const r: any = await W.crearProducto(ctx(api), { ...C, nombre: "CHUNKY MACADAMIA", categoria_id: 3, precio: 50 });
    expect(r.payload).toEqual({ product_name: "CHUNKY MACADAMIA", menu_category_id: 3, workshop: 1, weight_flag: 0, color: "grey", different_spots_prices: 0, modifications: 0, price: 5000, visible: 1 });
    expect(post).not.toHaveBeenCalled();
  });
  it("aplica y verifica el producto nuevo", async () => {
    const { api } = apiConEstado(base());
    const r: any = await W.crearProducto(ctx(api), { ...C, nombre: "CHUNKY MACADAMIA", categoria_id: 3, precio: 50, confirm: true });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.product_id).toBe(900);
  });
  it("rechaza duplicado y categoría inexistente", async () => {
    const { api } = apiConEstado(base());
    await expect(W.crearProducto(ctx(api), { ...C, nombre: "galleta eve", categoria_id: 3, precio: 50 })).rejects.toThrow(/renómbralo/);
    await expect(W.crearProducto(ctx(api), { ...C, nombre: "Nuevo", categoria_id: 99, precio: 50 })).rejects.toThrow(/Categoría 99/);
  });
});

describe("renombrar_platillo con receta", () => {
  it("renombra y la receta sigue intacta tras aplicar", async () => {
    const { api, post } = apiConEstado(base());
    const r: any = await W.renombrarPlatillo(ctx(api), { ...C, product_id: 710, nombre: "CHUNKY CHISPAS", confirm: true });
    expect(post.mock.calls[0][2].ingredient).toEqual([{ id: 512, type: 1, brutto: 1, netto: 1, lock: 1 }]);
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.receta_intacta).toBe(true);
  });
  it("manda los productos tipo 3 a actualizar_producto", async () => {
    const { api } = apiConEstado(base());
    await expect(W.renombrarPlatillo(ctx(api), { ...C, product_id: 638, nombre: "X" })).rejects.toThrow(/actualizar_producto/);
  });
});

describe("renombrar insumo", () => {
  it("insumo: conserva categoría y unidad; verifica", async () => {
    const { api } = apiConEstado(base());
    const dry: any = await W.renombrarInsumo(ctx(api), { ...C, ingredient_id: 317, nombre: "CHUNKY CHISPAS" });
    expect(dry.payload).toMatchObject({ id: 317, ingredient_name: "CHUNKY CHISPAS", category_id: 2, type: "p" });
    const r: any = await W.renombrarInsumo(ctx(api), { ...C, ingredient_id: 317, nombre: "CHUNKY CHISPAS", confirm: true });
    expect(r.verificacion.ok).toBe(true);
    await expect(W.renombrarInsumo(ctx(api), { ...C, ingredient_id: 317, nombre: "leche" })).rejects.toThrow(/Ya existe/);
  });
});
