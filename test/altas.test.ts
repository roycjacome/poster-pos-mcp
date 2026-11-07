// Altas de menú: crear_categoria, crear_precocinado, crear_platillo, ocultar_platillo.
import { describe, it, expect, vi } from "vitest";
import * as W from "../src/tools/escritura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const insumos = [
  { ingredient_id: 783, ingredient_name: "Salsa de calabaza", ingredient_unit: "l" },
  { ingredient_id: 784, ingredient_name: "Polvo de Calabaza", ingredient_unit: "kg" },
  { ingredient_id: 16, ingredient_name: "Leche deslactosada", ingredient_unit: "l" },
  { ingredient_id: 6, ingredient_name: "Leche de soya", ingredient_unit: "l" },
  { ingredient_id: 14, ingredient_name: "Vaso 12oz", ingredient_unit: "p" },
  { ingredient_id: 2, ingredient_name: "Insumo con ID repetido", ingredient_unit: "p" },
];
const prepacks = [{ product_id: "2", product_name: "Carga extra de café", unit: "kg", out: 60, ingredients: [] }];

// Forma real de menu.getProduct (cafe-01 892, leída el 23 oct 2026)
const psl = (): Obj => ({
  product_id: "892", product_name: "Pumpkin Spice Latte CH", menu_category_id: "23", workshop: "1", type: "2",
  color: "grey", weight_flag: "0", out: 85.3, price: { "1": "8500" },
  spots: [{ spot_id: "1", price: "8500", visible: "1" }],
  group_modifications: [{ dish_modification_group_id: 204, name: "Caliente o Fria", num_min: 1, num_max: 1, type: 1, modifications: [
    { dish_modification_id: 749, name: "HOT Pumpkin Spice Latte CH", ingredient_id: 891, type: 3, brutto: 0.25, price: 0, sort_order: 0 },
    { dish_modification_id: 750, name: "(ICED) Pumpkin Spice CH ", ingredient_id: 895, type: 3, brutto: 0.33, price: 0, sort_order: 1 },
  ] }],
  ingredients: [
    { ingredient_id: "783", structure_unit: "ml", structure_type: "1", structure_brutto: 25, structure_netto: 25, structure_lock: "1" },
    { ingredient_id: "2", structure_unit: "g", structure_type: "2", structure_brutto: 60, structure_netto: 60, structure_lock: "1" },
  ],
});

/** API falsa con estado: las escrituras mutan lo que se lee después (para probar la verificación). */
function apiConEstado(inicial: Obj) {
  const db = structuredClone(inicial);
  const post = vi.fn(async (_c: string, metodo: string, cuerpo: Obj) => {
    if (metodo === "menu.createCategory") {
      db["menu.getCategories"].push({ category_id: "99", category_name: cuerpo.category_name, parent_category: String(cuerpo.parent_category) });
      return { response: 99 };
    }
    if (metodo === "menu.createPrepack") {
      db["menu.getPrepacks"].push({ product_id: "900", product_name: cuerpo.product_name, out: 0,
        ingredients: cuerpo.ingredient.map((l: Obj) => ({ ingredient_id: String(l.id), structure_type: String(l.type), structure_brutto: l.brutto, structure_netto: l.netto, structure_lock: "1" })) });
      return { response: 900 };
    }
    if (metodo === "menu.createDish") {
      const p = {
        product_id: "1000", product_name: cuerpo.product_name, menu_category_id: String(cuerpo.menu_category_id), workshop: String(cuerpo.workshop), type: "2",
        price: { "1": String(cuerpo.price) }, spots: [{ spot_id: "1", price: String(cuerpo.price), visible: "1" }],
        ingredients: cuerpo.ingredient.map((l: Obj) => ({ ingredient_id: String(l.id), structure_type: String(l.type), structure_brutto: l.brutto, structure_netto: l.netto, structure_lock: "1" })),
        group_modifications: cuerpo.modificationgroup.map((g: Obj, i: number) => ({ dish_modification_group_id: 500 + i, name: g.name, num_min: g.minNum, num_max: g.maxNum, type: g.type,
          modifications: g.modifications.map((m: Obj, j: number) => ({ dish_modification_id: 800 + j, name: m.name, ingredient_id: m.ingredientId, type: m.type, brutto: m.brutto, price: m.price / 100 })) })),
      };
      db["menu.getProducts"].push(p);
      return { response: 1000 };
    }
    if (metodo === "menu.updateDish") {
      const p = db["menu.getProducts"].find((x: Obj) => Number(x.product_id) === cuerpo.dish_id);
      p.product_name = cuerpo.product_name;
      p.spots = Object.entries(cuerpo.visible).map(([s, v]) => ({ spot_id: s, visible: String(v) }));
      if (!cuerpo.ingredient) p.ingredients = []; // Póster borra la receta si no viene
      else p.ingredients = cuerpo.ingredient.map((l: Obj) => ({ ingredient_id: String(l.id), structure_type: String(l.type), structure_brutto: l.brutto, structure_netto: l.netto, structure_lock: "1" }));
      if (cuerpo.modificationgroup && cuerpo.modificationgroup.some((g: Obj) => !g.dish_modification_group_id))
        p.group_modifications = cuerpo.modificationgroup.map((g: Obj, i: number) => ({ dish_modification_group_id: 600 + i, name: g.name, num_min: g.minNum, num_max: g.maxNum, type: g.type,
          modifications: g.modifications.map((m: Obj, j: number) => ({ dish_modification_id: 900 + j, name: m.name, ingredient_id: m.ingredientId, type: m.type, brutto: m.brutto, price: m.price / 100 })) }));
      return { response: true };
    }
    return { error: 1 };
  });
  const api: PosterApi = {
    get: async (_c, m, params) => {
      if (m === "menu.getProduct") return structuredClone(db["menu.getProducts"].find((x: Obj) => Number(x.product_id) === Number(params?.product_id))) as never;
      return structuredClone(db[m]) as never;
    },
    post: post as never,
  };
  return { api, post, db };
}
const base = () => ({
  "menu.getIngredients": insumos,
  "menu.getPrepacks": prepacks,
  "menu.getCategories": [{ category_id: "23", category_name: "Bebida de Temporada", parent_category: "0" }],
  "menu.getProducts": [psl()],
});
const ctx = (api: PosterApi) => ({ api, actor: "test" });

const latte = (extra: Obj = {}) => ({
  cuenta: "cafe-04", nombre: "Latte de Calabaza CH", categoria_id: 23, workshop: 1, precio: 110,
  receta: [{ ingredient_id: 783, brutto: 25 }, { ingredient_id: 2, tipo: 2, brutto: 20 }, { ingredient_id: 784, brutto: 0.3 }, { ingredient_id: 14, brutto: 1 }],
  grupos: [{ nombre: "Tipo de leche", min: 1, max: 1, opciones: [
    { ingredient_id: 16, nombre: "Leche deslactosada", brutto: 230 },
    { ingredient_id: 6, nombre: "Leche de soya", brutto: 230, precio: 15 },
  ] }],
  ...extra,
});

describe("crear_categoria", () => {
  it("rechaza duplicado normalizado", async () => {
    const { api } = apiConEstado(base());
    await expect(W.crearCategoria(ctx(api), { cuenta: "cafe-04", nombre: "bebida de temporada" })).rejects.toThrow(/Ya existe/);
  });
  it("dry-run no escribe; confirm crea y verifica", async () => {
    const { api, post } = apiConEstado(base());
    const d: any = await W.crearCategoria(ctx(api), { cuenta: "cafe-04", nombre: "Bebidas de Temporada 2" });
    expect(d.modo).toBe("dry-run");
    expect(d.payload).toEqual({ category_name: "Bebidas de Temporada 2", parent_category: 0, category_color: "orange", category_hidden: 0 });
    expect(post).not.toHaveBeenCalled();
    const r: any = await W.crearCategoria(ctx(api), { cuenta: "cafe-04", nombre: "Bebidas de Temporada 2", confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
  });
  it("otra cuenta sin flag queda bloqueada", async () => {
    const { api, post } = apiConEstado(base());
    await expect(W.crearCategoria(ctx(api), { cuenta: "cafe-02", nombre: "X", confirm: true })).rejects.toThrow(/bloqueada/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("crear_precocinado", () => {
  it("valida IDs por tipo (2 existe como insumo pero no como precocinado 783)", async () => {
    const { api } = apiConEstado(base());
    await expect(W.crearPrecocinado(ctx(api), { cuenta: "cafe-04", nombre: "Té de durazno listo", receta: [{ ingredient_id: 783, tipo: 2, brutto: 5 }] })).rejects.toThrow(/Precocinado 783 no existe/);
  });
  it("rechaza nombre existente", async () => {
    const { api } = apiConEstado(base());
    await expect(W.crearPrecocinado(ctx(api), { cuenta: "cafe-04", nombre: "carga extra de cafe", receta: [{ ingredient_id: 783, brutto: 5 }] })).rejects.toThrow(/Ya existe/);
  });
  it("arma el payload con lock 1 y verifica la receta leída", async () => {
    const { api } = apiConEstado(base());
    const r: any = await W.crearPrecocinado(ctx(api), { cuenta: "cafe-04", nombre: "Té de durazno listo", receta: [{ ingredient_id: 784, brutto: 5 }, { ingredient_id: 16, brutto: 1000 }], confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.product_id).toBe(900);
  });
});

describe("crear_platillo", () => {
  it("dry-run: precio y opciones en centavos, leche obligatoria, nada se escribe", async () => {
    const { api, post } = apiConEstado(base());
    const r: any = await W.crearPlatillo(ctx(api), latte());
    expect(r.modo).toBe("dry-run");
    expect(r.payload.price).toBe(11000);
    expect(r.payload.nodiscount).toBe(0);
    expect(r.payload.ingredient[1]).toEqual({ id: 2, type: 2, brutto: 20, netto: 20, lock: 1 });
    expect(r.payload.modificationgroup[0]).toEqual({ name: "Tipo de leche", type: 1, minNum: 1, maxNum: 1, modifications: [
      { ingredientId: 16, type: 10, name: "Leche deslactosada", brutto: 230, price: 0 },
      { ingredientId: 6, type: 10, name: "Leche de soya", brutto: 230, price: 1500 },
    ] });
    expect(r.avisos).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });
  it("avisa leche opcional, precio $0 y workshop sin uso", async () => {
    const { api } = apiConEstado(base());
    const g = latte().grupos;
    g[0].min = 0;
    const r: any = await W.crearPlatillo(ctx(api), latte({ precio: 0, workshop: 7, grupos: g }));
    expect(r.avisos.join(" ")).toMatch(/\$0/);
    expect(r.avisos.join(" ")).toMatch(/opcional/);
    expect(r.avisos.join(" ")).toMatch(/workshop 7/);
  });
  it("rechaza insumo inexistente en opción y nombre duplicado", async () => {
    const { api } = apiConEstado(base());
    const g = latte().grupos;
    g[0].opciones[0].ingredient_id = 4242;
    await expect(W.crearPlatillo(ctx(api), latte({ grupos: g }))).rejects.toThrow(/Insumo 4242/);
    await expect(W.crearPlatillo(ctx(api), latte({ nombre: "pumpkin spice latte ch" }))).rejects.toThrow(/Ya existe/);
  });
  it("confirm: crea, relee y verifica receta, grupos y precio", async () => {
    const { api, post } = apiConEstado(base());
    const r: any = await W.crearPlatillo(ctx(api), latte({ confirm: true }));
    expect(post).toHaveBeenCalledOnce();
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.product_id).toBe(1000);
  });
  it("detecta receta perdida al verificar", async () => {
    const { api, db } = apiConEstado(base());
    const post = vi.fn(async () => {
      db["menu.getProducts"].push({ product_id: "1000", product_name: "Latte de Calabaza CH", type: "2", price: { "1": "11000" }, spots: [], ingredients: [], group_modifications: [] });
      return { response: 1000 };
    });
    const r: any = await W.crearPlatillo(ctx({ ...api, post: post as never }), latte({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(JSON.stringify(r.verificacion.detalle.fallas)).toMatch(/receta_leida/);
  });
});

describe("ocultar_platillo", () => {
  it("dry-run: payload COMPLETO con receta, IDs de grupos/opciones, visible 0 y sufijo", async () => {
    const { api, post } = apiConEstado(base());
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 892 });
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(r.payload.product_name).toBe("Pumpkin Spice Latte CH (old)");
    expect(r.payload.visible).toEqual({ "1": 0 });
    expect(r.payload.price).toEqual({ "1": 8500 });
    expect(r.payload.workshop).toBe(1);
    expect(r.payload.ingredient).toEqual([{ id: 783, type: 1, brutto: 25, netto: 25, lock: 1 }, { id: 2, type: 2, brutto: 60, netto: 60, lock: 1 }]);
    expect(r.payload).not.toHaveProperty("ingredient[]");
    const g = r.payload.modificationgroup[0];
    expect(g.dish_modification_group_id).toBe(204);
    expect(g.modifications.map((m: any) => m.dish_modification_id)).toEqual([749, 750]);
    expect(g.modifications[0]).not.toHaveProperty("_id");
    expect(r.cambios.map((c: any) => c.campo).sort()).toEqual(["product_name", "visible.1"]);
  });
  it("confirm: oculta y verifica receta y grupos intactos", async () => {
    const { api } = apiConEstado(base());
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 892, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.receta_intacta).toBe(true);
  });
  it("idempotente: ya oculto y renombrado → error claro sin escribir", async () => {
    const p = { ...psl(), product_name: "Pumpkin Spice Latte CH (old)", spots: [{ spot_id: "1", visible: "0" }] };
    const { api, post } = apiConEstado({ ...base(), "menu.getProducts": [p] });
    await expect(W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 892, confirm: true })).rejects.toThrow(/ya está oculto/);
    expect(post).not.toHaveBeenCalled();
  });
  it("platillo sin receta manda ingredient[] vacío", async () => {
    const p = { ...psl(), ingredients: [] };
    const { api } = apiConEstado({ ...base(), "menu.getProducts": [p] });
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 892 });
    expect(r.payload["ingredient[]"]).toEqual([]);
    expect(r.payload).not.toHaveProperty("ingredient");
  });
  it("cae a menu.getProducts si getProduct falla", async () => {
    const { api } = apiConEstado(base());
    const get = api.get;
    const api2: PosterApi = { ...api, get: async (c, m, p) => { if (m === "menu.getProduct") throw new Error("x"); return get(c, m, p); } };
    const r: any = await W.ocultarPlatillo(ctx(api2), { cuenta: "cafe-04", product_id: 892 });
    expect(r.payload.dish_id).toBe(892);
  });
});

describe("borrar_platillo_old", () => {
  const old = () => ({ ...psl(), product_name: "Pumpkin Spice Latte CH (old)", spots: [{ spot_id: "1", visible: "0" }] });
  it("rechaza visibles o sin sufijo (old)", async () => {
    const { api, post } = apiConEstado(base());
    await expect(W.borrarPlatilloOld(ctx(api), { cuenta: "cafe-04", product_id: 892, confirm: true })).rejects.toThrow(/no termina en/);
    const p = { ...old(), spots: [{ spot_id: "1", visible: "1" }] };
    const b = apiConEstado({ ...base(), "menu.getProducts": [p] });
    await expect(W.borrarPlatilloOld(ctx(b.api), { cuenta: "cafe-04", product_id: 892, confirm: true })).rejects.toThrow(/sigue visible/);
    expect(post).not.toHaveBeenCalled();
  });
  it("dry-run no escribe; confirm manda removeDish y verifica", async () => {
    const { api, post, db } = apiConEstado({ ...base(), "menu.getProducts": [old()] });
    const d: any = await W.borrarPlatilloOld(ctx(api), { cuenta: "cafe-04", product_id: 892 });
    expect(d.modo).toBe("dry-run");
    expect(d.payload).toEqual({ dish_id: 892 });
    expect(post).not.toHaveBeenCalled();
    const api2 = { ...api, post: (async (_c: string, m: string, b: any) => { db["menu.getProducts"] = db["menu.getProducts"].filter((x: any) => Number(x.product_id) !== b.dish_id); return { response: true }; }) as never };
    const r: any = await W.borrarPlatilloOld(ctx(api2), { cuenta: "cafe-04", product_id: 892, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
  });
  it("otra cuenta sin flag bloqueada", async () => {
    const { api } = apiConEstado({ ...base(), "menu.getProducts": [old()] });
    await expect(W.borrarPlatilloOld(ctx(api), { cuenta: "cafe-02", product_id: 892, confirm: true })).rejects.toThrow(/bloqueada/);
  });
});

describe("actualizar_receta_platillo + opciones platillo (Servicio estilo 47)", () => {
  const auxLlevar = { product_id: "357", product_name: "Para llevar caliente 12 oz", type: "2", price: { "1": "0" }, spots: [{ spot_id: "1", visible: "1" }], group_modifications: [], ingredients: [{ ingredient_id: "14", structure_type: "1", structure_brutto: 1 }] };
  const auxTaza = { product_id: "358", product_name: "En taza (cerámica)", type: "2", price: { "1": "0" }, spots: [{ spot_id: "1", visible: "0" }], group_modifications: [], ingredients: [] };
  const servicio = { nombre: "Servicio", tipo: 1 as const, min: 1, max: 1, opciones: [
    { ingredient_id: 358, tipo: "platillo" as const, nombre: "En taza (cerámica)", brutto: 1 },
    { ingredient_id: 357, tipo: "platillo" as const, nombre: "Para llevar 12 oz", brutto: 1 }] };
  const conAux = () => ({ ...base(), "menu.getProducts": [psl(), auxLlevar, auxTaza] });

  it("dry-run: conserva nombre/precio/visible, receta y grupos nuevos con type 2", async () => {
    const { api, post } = apiConEstado(conAux());
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 892, receta: [{ ingredient_id: 783, brutto: 20 }, { ingredient_id: 2, tipo: 2, brutto: 20 }], grupos: [servicio] });
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(r.payload.product_name).toBe("Pumpkin Spice Latte CH");
    expect(r.payload.price).toEqual({ "1": 8500 });
    expect(r.payload.visible).toEqual({ "1": 1 });
    expect(r.payload.ingredient).toEqual([{ id: 783, type: 1, brutto: 20, netto: 20, lock: 1 }, { id: 2, type: 2, brutto: 20, netto: 20, lock: 1 }]);
    expect(r.payload.modificationgroup[0].modifications.map((m: any) => m.type)).toEqual([2, 2]);
  });
  it("rechaza auxiliar inexistente o con grupos propios", async () => {
    const { api } = apiConEstado(conAux());
    const malo = { ...servicio, opciones: [{ ...servicio.opciones[0], ingredient_id: 892 }] };
    await expect(W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 357, receta: [{ ingredient_id: 14, brutto: 1 }], grupos: [malo] })).rejects.toThrow(/grupos propios/);
    const inexistente = { ...servicio, opciones: [{ ...servicio.opciones[0], ingredient_id: 4242 }] };
    await expect(W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 892, receta: [{ ingredient_id: 14, brutto: 1 }], grupos: [inexistente] })).rejects.toThrow(/no existe/);
  });
  it("confirm: aplica y verifica receta y grupos", async () => {
    const { api } = apiConEstado(conAux());
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 892, receta: [{ ingredient_id: 783, brutto: 20 }], grupos: [servicio], confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
  });
  it("crear_platillo acepta opciones tipo platillo", async () => {
    const { api } = apiConEstado(conAux());
    const r: any = await W.crearPlatillo(ctx(api), { ...latte(), grupos: [...latte().grupos, servicio] });
    expect(r.payload.modificationgroup[1].modifications[1]).toEqual({ ingredientId: 357, type: 2, name: "Para llevar 12 oz", brutto: 1, price: 0 });
  });
});
