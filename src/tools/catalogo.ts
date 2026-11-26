// Herramientas para ESTANDARIZAR CATÁLOGOS en toda la red (ej. galletas Chunky en 7 sucursales).
// Módulo independiente: no modifica escritura.ts ni mcp.ts más allá de una línea de registro, para poder
// instalarse encima de versiones locales más nuevas del servidor.
//   · actualizar_producto / crear_producto: productos de reventa (tipo 3, sin receta)
//   · renombrar_platillo: nombre, precio o visibilidad de platillos (tipo 2), CON o SIN receta (la reenvía y verifica)
//   · renombrar_insumo   (proveedores: la API no tiene storage.updateSupplier → se renombran en el panel)
// Mismas reglas que escritura.ts: dry-run por defecto, cuenta por defecto = WRITE_DEFAULT_ACCOUNTS,
// otra cuenta exige permitir_otra_cuenta, auditoría de todo, verificación leyendo de vuelta.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PosterApi, PosterRespuesta } from "../poster.js";
import { errorPoster } from "../poster.js";
import { CUENTAS, config, verificarEscritura } from "../config.js";
import { auditar } from "../audit.js";
import { redactar } from "../tokens.js";
import { centavos, diff, norm, num, pesos, type Cambio } from "../util.js";

type Obj = Record<string, any>;
export interface Contexto { api: PosterApi; actor: string; cliente?: string }
export interface BaseEscritura { cuenta: string; confirm?: boolean; permitir_otra_cuenta?: boolean }
interface Plan {
  herramienta: string;
  metodo: string;
  payload: Obj;
  antes: unknown;
  despues: unknown;
  avisos?: string[];
  verificar?: (r: PosterRespuesta) => Promise<{ ok: boolean; detalle: unknown }>;
}

async function ejecutar(ctx: Contexto, a: BaseEscritura, construir: () => Promise<Plan>) {
  const base = { actor: ctx.actor, cliente: ctx.cliente, cuenta: a.cuenta };
  let herramienta = "?";
  try {
    verificarEscritura(a.cuenta, a.permitir_otra_cuenta);
    const plan = await construir();
    herramienta = plan.herramienta;
    const cambios: Cambio[] = diff(plan.antes ?? {}, plan.despues);
    if (!a.confirm) {
      auditar({ ...base, herramienta, metodo: plan.metodo, modo: "dry-run", payload: plan.payload });
      return { modo: "dry-run", cuenta: a.cuenta, metodo: plan.metodo, cambios, avisos: plan.avisos ?? [], payload: plan.payload, siguiente_paso: "Revisa el diff. Para aplicar, repite la llamada con confirm: true." };
    }
    const r = await ctx.api.post(a.cuenta, plan.metodo, plan.payload);
    const err = errorPoster(r);
    if (err || (r.response === undefined && r.success !== 1)) {
      auditar({ ...base, herramienta, metodo: plan.metodo, modo: "rechazado", payload: plan.payload, resultado: r, error: err ?? "sin response" });
      return { modo: "rechazado", cuenta: a.cuenta, metodo: plan.metodo, error: err ?? r, payload: plan.payload };
    }
    const verificacion = plan.verificar ? await plan.verificar(r) : { ok: true, detalle: "sin verificación" };
    auditar({ ...base, herramienta, metodo: plan.metodo, modo: "aplicado", payload: plan.payload, resultado: { respuesta: r.response, verificacion } });
    return { modo: "aplicado", cuenta: a.cuenta, metodo: plan.metodo, respuesta: r.response, cambios, verificacion };
  } catch (e) {
    auditar({ ...base, herramienta, metodo: "-", modo: "rechazado", payload: a, error: String((e as Error).message ?? e) });
    throw e;
  }
}

// ── Lectura y contratos de Póster (copias locales para no depender de la versión de escritura.ts) ──
async function leerProducto(api: PosterApi, cuenta: string, productId: number): Promise<Obj | undefined> {
  try {
    const p = await api.get<Obj>(cuenta, "menu.getProduct", { product_id: productId });
    if (p && num(p.product_id) === productId) return p;
  } catch { /* cae a la lista */ }
  const prods = await api.get<Obj[]>(cuenta, "menu.getProducts");
  return (prods ?? []).find((x) => num(x.product_id) === productId);
}

/** Payload COMPLETO de updateDish (precio del platillo en centavos; opción se lee en pesos y se escribe en centavos). */
function payloadUpdateDish(p: Obj) {
  const precio: Obj = p.price && Object.keys(p.price).length ? p.price : { 1: 0 };
  const spots = Object.keys(precio);
  const vis = Object.fromEntries((p.spots ?? []).map((s: Obj) => [String(s.spot_id), String(s.visible) === "1" ? 1 : 0]));
  return {
    dish_id: num(p.product_id),
    product_name: String(p.product_name),
    menu_category_id: num(p.menu_category_id),
    workshop: num(p.workshop) || 1,
    product_color: p.color || "grey",
    weight_flag: num(p.weight_flag),
    out: num(p.out),
    price: Object.fromEntries(spots.map((s) => [s, num(precio[s])])) as Obj,
    visible: Object.fromEntries(spots.map((s) => [s, vis[s] ?? 1])) as Obj,
    modificationgroup: (p.group_modifications ?? []).map((g: Obj) => ({
      name: String(g.name).trim(),
      type: num(g.type) || 1,
      num_min: num(g.num_min),
      num_max: num(g.num_max) || 1,
      minNum: num(g.num_min),
      maxNum: num(g.num_max) || 1,
      modifications: (g.modifications ?? []).map((m: Obj) => ({
        name: m.name, ingredientId: num(m.ingredient_id), ingredient_id: num(m.ingredient_id), type: num(m.type) || 1,
        brutto: num(m.brutto) || 1, price: centavos(m.price), sort_order: num(m.sort_order), _id: num(m.dish_modification_id),
      })),
    })) as Obj[],
  };
}
function recetaParaEscribir(p: Obj) {
  return (p.ingredients ?? []).map((l: Obj) => ({
    id: num(l.ingredient_id), type: num(l.structure_type) || 1, brutto: num(l.structure_brutto),
    netto: num(l.structure_netto) || num(l.structure_brutto), lock: l.structure_lock === undefined ? 1 : num(l.structure_lock),
  }));
}
const firmaReceta = (r: Array<{ id: number; type: number; brutto: number }>) => r.map((l) => `${l.type}_${l.id}:${l.brutto}`).sort();
const firmaGrupos = (gs: Obj[]) =>
  gs.map((g) => `${String(g.name).trim()}|${num(g.num_min ?? g.minNum)}-${num(g.num_max ?? g.maxNum)}|` +
    (g.modifications ?? []).map((m: Obj) => `${num(m.ingredient_id ?? m.ingredientId)}:${num(m.brutto)}@${num(m.price)}`).sort().join(",")).sort();

// ── renombrar_platillo (tipo 2, con o sin receta) ───────────────────────────
export async function renombrarPlatillo(
  ctx: Contexto,
  a: BaseEscritura & { product_id: number; nombre?: string; precio?: number; visible?: boolean },
) {
  return ejecutar(ctx, a, async () => {
    const p = await leerProducto(ctx.api, a.cuenta, a.product_id);
    if (!p) throw new Error(`Producto ${a.product_id} no existe en ${a.cuenta}`);
    if (num(p.type) === 3) throw new Error(`"${String(p.product_name).trim()}" es producto de reventa (tipo 3): usa actualizar_producto.`);
    if (num(p.type) !== 2) throw new Error(`"${p.product_name}" es tipo ${p.type}, no platillo (2).`);
    if (a.nombre === undefined && a.precio === undefined && a.visible === undefined) throw new Error("Nada que cambiar.");
    if (a.nombre !== undefined) {
      const prods = await ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts");
      const dup = prods.find((x) => num(x.product_id) !== a.product_id && norm(x.product_name) === norm(a.nombre!));
      if (dup) throw new Error(`Ya existe "${String(dup.product_name).trim()}" (id ${dup.product_id}) en ${a.cuenta}.`);
    }
    const receta = recetaParaEscribir(p);
    const base = payloadUpdateDish(p);
    // Grupos con sus IDs (como ocultar_platillo) para que Póster no los recree
    const grupos = (p.group_modifications ?? []).map((g: Obj, gi: number) => ({
      dish_modification_group_id: num(g.dish_modification_group_id),
      ...base.modificationgroup[gi],
      modifications: base.modificationgroup[gi].modifications.map(({ _id, ...m }: Obj) => ({ dish_modification_id: _id, ...m })),
    }));
    // TRAMPA: updateDish vacía la receta si no se reenvía. Con receta → `ingredient`; sin receta → "ingredient[]": [].
    const antes: Obj = { ...base, modificationgroup: grupos, ...(receta.length ? { ingredient: receta } : { "ingredient[]": [] }) };
    const payload: Obj = structuredClone(antes);
    if (a.nombre !== undefined) payload.product_name = a.nombre;
    if (a.precio !== undefined) for (const s of Object.keys(payload.price)) payload.price[s] = centavos(a.precio);
    if (a.visible !== undefined) for (const s of Object.keys(payload.visible)) payload.visible[s] = a.visible ? 1 : 0;
    return {
      herramienta: "renombrar_platillo",
      metodo: "menu.updateDish",
      payload,
      antes,
      despues: payload,
      avisos: [receta.length
        ? `Tiene receta (${receta.length} líneas): se reenvía completa con ${grupos.length} grupos; tras aplicar se verifica que quedó intacta.`
        : `Sin receta: se reenvían ${grupos.length} grupos, precios y visibilidad actuales.`],
      verificar: async () => {
        const v = await leerProducto(ctx.api, a.cuenta, a.product_id);
        if (!v) return { ok: false, detalle: "no aparece" };
        const leido = payloadUpdateDish(v);
        const recetaOk = JSON.stringify(firmaReceta(recetaParaEscribir(v))) === JSON.stringify(firmaReceta(receta));
        const gruposOk = JSON.stringify(firmaGrupos(v.group_modifications ?? [])) === JSON.stringify(firmaGrupos(p.group_modifications ?? []));
        const nombreOk = String(v.product_name).trim() === String(payload.product_name).trim();
        const precioOk = JSON.stringify(leido.price) === JSON.stringify(payload.price);
        const visOk = JSON.stringify(leido.visible) === JSON.stringify(payload.visible);
        return { ok: recetaOk && gruposOk && nombreOk && precioOk && visOk, detalle: { nombre: v.product_name, receta_intacta: recetaOk, grupos_intactos: gruposOk, precio_ok: precioOk, visibilidad_ok: visOk } };
      },
    };
  });
}

// ── Productos de reventa (tipo 3: se compran y se venden tal cual, sin receta) ─
// Contrato (docs oficiales joinposter/docs, en/web/menu/updateProduct.md y createProduct.md):
//   · `modifications` 0 = producto sin modificaciones (obligatorio: sin él Póster responde "modifications is empty").
//   · `different_spots_prices` 0 → `price` y `visible` son ESCALARES; 1 → mapas por spot {spot_id: valor}.
//   · precio y costo en centavos. Update usa `id`. Se reenvía `barcode` para no borrarlo.
// Productos CON modificaciones (variantes con precio propio) no se tocan aquí.
const spotsDe = (p: Obj): string[] => {
  const desdePrecio = p.price && typeof p.price === "object" ? Object.keys(p.price) : [];
  const desdeSpots = (p.spots ?? []).map((s: Obj) => String(s.spot_id));
  const todos = [...new Set([...desdePrecio, ...desdeSpots])];
  return todos.length ? todos : ["1"];
};
/** Precio (centavos) y visibilidad por spot, leídos de getProduct/getProducts. */
function leerPrecioVis(p: Obj) {
  const spots = spotsDe(p);
  const precio = p.price && typeof p.price === "object" ? p.price : {};
  const vis = Object.fromEntries((p.spots ?? []).map((s: Obj) => [String(s.spot_id), String(s.visible) === "1" ? 1 : 0]));
  return {
    price: Object.fromEntries(spots.map((s) => [s, num(precio[s] ?? (p.spots ?? []).find((x: Obj) => String(x.spot_id) === s)?.price)])) as Obj,
    visible: Object.fromEntries(spots.map((s) => [s, vis[s] ?? 1])) as Obj,
  };
}
const conModificaciones = (p: Obj) => Array.isArray(p.modifications) && p.modifications.length > 0;

/** Arma el payload de updateProduct según el contrato y devuelve también lo que se espera leer de vuelta. */
function payloadProducto(p: Obj, cambios: { nombre?: string; categoria_id?: number; precio?: number; visible?: boolean; color?: string } = {}) {
  const dsp = num(p.different_spots_prices) === 1 ? 1 : 0;
  const pv = leerPrecioVis(p);
  const esperado = { price: { ...pv.price }, visible: { ...pv.visible } };
  if (cambios.precio !== undefined) for (const s of Object.keys(esperado.price)) esperado.price[s] = centavos(cambios.precio);
  if (cambios.visible !== undefined) for (const s of Object.keys(esperado.visible)) esperado.visible[s] = cambios.visible ? 1 : 0;
  const primero = Object.keys(esperado.price)[0];
  const payload: Obj = {
    id: num(p.product_id),
    product_name: cambios.nombre ?? String(p.product_name).trim(),
    menu_category_id: cambios.categoria_id ?? num(p.menu_category_id),
    workshop: num(p.workshop) || 1,
    weight_flag: num(p.weight_flag),
    color: cambios.color ?? (p.color || "grey"),
    different_spots_prices: dsp,
    modifications: 0,
    barcode: String(p.barcode ?? ""),
    price: dsp ? esperado.price : esperado.price[primero],
    visible: dsp ? esperado.visible : esperado.visible[primero],
  };
  return { payload, esperado: { product_name: String(payload.product_name), ...esperado } };
}

function verificarProducto(ctx: Contexto, cuenta: string, productId: number, esperado: { product_name: string; price: Obj; visible: Obj }) {
  return async () => {
    const v = await leerProducto(ctx.api, cuenta, productId);
    if (!v) return { ok: false, detalle: "no aparece" };
    const leido = leerPrecioVis(v);
    const nombre = String(v.product_name).trim();
    const fallas: unknown[] = [];
    if (nombre !== esperado.product_name.trim()) fallas.push({ nombre_esperado: esperado.product_name, nombre_leido: nombre });
    for (const [s, c] of Object.entries(esperado.price)) {
      const l = num(leido.price[s]);
      if (l !== num(c)) fallas.push({ spot: s, precio_esperado_centavos: c, precio_leido_centavos: l, ...(l && num(c) && (l * 100 === num(c) || l === num(c) * 100) ? { alerta_100x: "El precio quedó 100× desviado: corrígelo en el panel y no reintentes." } : {}) });
    }
    for (const [s, x] of Object.entries(esperado.visible)) if (num(leido.visible[s]) !== num(x)) fallas.push({ spot: s, visible_esperado: x, visible_leido: leido.visible[s] });
    return { ok: fallas.length === 0, detalle: fallas.length ? { fallas } : { nombre, precio_pesos: pesos(Object.values(leido.price)[0]), visible: leido.visible } };
  };
}

export async function actualizarProducto(
  ctx: Contexto,
  a: BaseEscritura & { product_id: number; nombre?: string; categoria_id?: number; precio?: number; visible?: boolean; color?: string },
) {
  return ejecutar(ctx, a, async () => {
    const p = await leerProducto(ctx.api, a.cuenta, a.product_id);
    if (!p) throw new Error(`Producto ${a.product_id} no existe en ${a.cuenta}`);
    if (num(p.type) !== 3) throw new Error(`"${String(p.product_name).trim()}" es tipo ${p.type}, no producto de reventa (3): usa renombrar_platillo.`);
    if (conModificaciones(p)) throw new Error(`"${String(p.product_name).trim()}" tiene modificaciones (variantes con precio propio): edítalo en el panel.`);
    if (a.nombre === undefined && a.categoria_id === undefined && a.precio === undefined && a.visible === undefined && a.color === undefined) throw new Error("Nada que cambiar.");
    if (a.categoria_id !== undefined) {
      const cats = await ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories");
      if (!cats.some((c) => num(c.category_id) === a.categoria_id)) throw new Error(`Categoría ${a.categoria_id} no existe`);
    }
    if (a.nombre !== undefined) {
      const prods = await ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts");
      const dup = prods.find((x) => num(x.product_id) !== a.product_id && norm(x.product_name) === norm(a.nombre!));
      if (dup) throw new Error(`Ya existe "${String(dup.product_name).trim()}" (id ${dup.product_id}) en ${a.cuenta}.`);
    }
    const antes = payloadProducto(p).payload;
    const { payload, esperado } = payloadProducto(p, a);
    return {
      herramienta: "actualizar_producto",
      metodo: "menu.updateProduct",
      payload,
      antes,
      despues: payload,
      avisos: ["Producto de reventa (tipo 3): renombrarlo también renombra su existencia en almacén y conserva el historial de ventas y compras."],
      verificar: verificarProducto(ctx, a.cuenta, a.product_id, esperado),
    };
  });
}

export async function crearProducto(
  ctx: Contexto,
  a: BaseEscritura & { nombre: string; categoria_id: number; precio: number; costo?: number; workshop?: number; color?: string; visible?: boolean },
) {
  return ejecutar(ctx, a, async () => {
    const [prods, cats] = await Promise.all([ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts"), ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories")]);
    const dup = (prods ?? []).find((x) => norm(x.product_name) === norm(a.nombre));
    if (dup) throw new Error(`Ya existe "${String(dup.product_name).trim()}" (id ${dup.product_id}, tipo ${dup.type}) en ${a.cuenta}: renómbralo en vez de crear otro.`);
    if (!cats.some((c) => num(c.category_id) === a.categoria_id)) throw new Error(`Categoría ${a.categoria_id} no existe en ${a.cuenta}`);
    // Spots y workshop se toman de un producto hermano de la misma categoría (o del primero de la cuenta)
    const hermano = (prods ?? []).find((x) => num(x.menu_category_id) === a.categoria_id) ?? (prods ?? [])[0] ?? {};
    const spots = spotsDe(hermano);
    const vis = a.visible === false ? 0 : 1;
    const payload: Obj = {
      product_name: a.nombre,
      menu_category_id: a.categoria_id,
      workshop: a.workshop ?? (num(hermano.workshop) || 1),
      weight_flag: 0,
      color: a.color ?? "grey",
      different_spots_prices: 0,
      modifications: 0,
      price: centavos(a.precio),
      visible: vis,
      ...(a.costo !== undefined ? { cost: centavos(a.costo) } : {}),
    };
    const esperado = { product_name: a.nombre, price: Object.fromEntries(spots.map((s) => [s, centavos(a.precio)])), visible: Object.fromEntries(spots.map((s) => [s, vis])) };
    return {
      herramienta: "crear_producto",
      metodo: "menu.createProduct",
      payload,
      antes: {},
      despues: { ...payload, precio_pesos: a.precio, ...(a.costo !== undefined ? { costo_pesos: a.costo } : {}) },
      avisos: ["Crea un producto de reventa (tipo 3): sin receta; su existencia se mueve con compras a nombre del mismo producto."],
      verificar: async (r) => {
        const id = num(typeof r.response === "object" && r.response ? (r.response as Obj).product_id : r.response);
        if (!id) return { ok: false, detalle: { respuesta: r.response, alerta: "Póster no devolvió el id del producto nuevo." } };
        const v = await verificarProducto(ctx, a.cuenta, id, esperado)();
        return { ...v, detalle: { product_id: id, ...(typeof v.detalle === "object" ? v.detalle as Obj : { detalle: v.detalle }) } };
      },
    };
  });
}

// ── Renombrar insumo (menu.updateIngredient) ────────────────────────────────
// Contrato oficial (en/web/menu/updateIngredient.md): {id, ingredient_name, category_id, type, weight_ingredient}.
// Tras aplicar se relee menu.getIngredients y se comparan nombre, categoría y unidad.
export async function renombrarInsumo(ctx: Contexto, a: BaseEscritura & { ingredient_id: number; nombre: string }) {
  return ejecutar(ctx, a, async () => {
    const ings = await ctx.api.get<Obj[]>(a.cuenta, "menu.getIngredients");
    const i = (ings ?? []).find((x) => num(x.ingredient_id) === a.ingredient_id);
    if (!i) throw new Error(`Insumo ${a.ingredient_id} no existe en ${a.cuenta}`);
    const dup = (ings ?? []).find((x) => num(x.ingredient_id) !== a.ingredient_id && norm(x.ingredient_name) === norm(a.nombre));
    if (dup) throw new Error(`Ya existe el insumo "${dup.ingredient_name}" (id ${dup.ingredient_id}).`);
    const unidad = String(i.ingredient_unit ?? i.unit ?? "p");
    const antes = { id: a.ingredient_id, ingredient_name: String(i.ingredient_name).trim(), category_id: num(i.category_id), type: unidad, weight_ingredient: num(i.ingredient_weight ?? i.weight_ingredient) };
    const payload = { ...antes, ingredient_name: a.nombre };
    return {
      herramienta: "renombrar_insumo",
      metodo: "menu.updateIngredient",
      payload,
      antes,
      despues: payload,
      avisos: ["La unidad no cambia (Póster no deja cambiarla si el insumo ya tuvo compras)."],
      verificar: async () => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "menu.getIngredients")).find((x) => num(x.ingredient_id) === a.ingredient_id);
        if (!v) return { ok: false, detalle: "el insumo ya no aparece: revisa el panel" };
        const ok = String(v.ingredient_name).trim() === a.nombre.trim() && num(v.category_id) === antes.category_id && String(v.ingredient_unit ?? v.unit ?? "p") === unidad;
        return { ok, detalle: { nombre: v.ingredient_name, categoria: v.category_id, unidad: v.ingredient_unit ?? v.unit } };
      },
    };
  });
}

// ── Registro en el servidor MCP ─────────────────────────────────────────────
export function registrarCatalogo(s: McpServer, api: PosterApi) {
  const defecto = ([...config.writeDefault][0] ?? CUENTAS[0]) as (typeof CUENTAS)[number];
  const cuenta = z.enum(CUENTAS).default(defecto).describe(`Cuenta destino (por defecto ${defecto})`);
  const escritura = {
    confirm: z.boolean().default(false).describe("false = dry-run (solo muestra el diff). true = aplica el cambio."),
    permitir_otra_cuenta: z.boolean().default(false).describe(`Requerido en true para escribir en una cuenta distinta de ${defecto}. Solo con autorización explícita de Roy.`),
  };
  const ESCRITURA = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
  const ctx = (extra: any): Contexto => ({ api, actor: (extra?.authInfo?.extra?.sub as string) ?? extra?.authInfo?.clientId ?? "desconocido", cliente: extra?.authInfo?.clientId });
  const envolver = <A>(fn: (a: A, extra: any) => Promise<unknown>) => async (a: A, extra: any) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn(a, extra), null, 1) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text" as const, text: redactar(String((e as Error)?.message ?? e)) }] }; }
  };

  s.registerTool("actualizar_producto", {
    title: "Actualizar producto de reventa",
    description:
      "menu.updateProduct para productos tipo 3 (se compran y se venden tal cual, sin receta: galletas, embotellados, postres de proveedor). " +
      "Cambia nombre, categoría, precio (pesos), visibilidad o color; rechaza nombres duplicados. Renombrar conserva historial de ventas y compras. " +
      "Tras aplicar relee y compara nombre, precio y visibilidad (avisa si el precio quedó 100× desviado). Dry-run por defecto.",
    inputSchema: {
      cuenta, product_id: z.number().int(), nombre: z.string().min(1).optional(), categoria_id: z.number().int().optional(),
      precio: z.number().min(0).optional().describe("Precio en pesos, igual en todos los spots"), visible: z.boolean().optional(), color: z.string().optional(), ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => actualizarProducto(ctx(extra), a)));

  s.registerTool("crear_producto", {
    title: "Crear producto de reventa",
    description:
      "menu.createProduct: alta de un producto tipo 3 (sin receta) con precio en pesos. Rechaza nombre duplicado y valida la categoría; " +
      "toma spots y workshop de un producto de la misma categoría. Tras aplicar relee y verifica nombre, precio y visibilidad. Dry-run por defecto.",
    inputSchema: {
      cuenta, nombre: z.string().min(1), categoria_id: z.number().int(), precio: z.number().min(0).describe("Pesos"), costo: z.number().min(0).optional().describe("Costo inicial en pesos (se usa hasta la primera compra)"),
      workshop: z.number().int().min(0).optional(), color: z.string().optional(), visible: z.boolean().optional().describe("Default true"), ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => crearProducto(ctx(extra), a)));

  s.registerTool("renombrar_platillo", {
    title: "Renombrar platillo (con o sin receta)",
    description:
      "menu.updateDish COMPLETO para cambiar nombre, precio (pesos) o visibilidad de un platillo tipo 2, aunque tenga receta: " +
      "la reenvía completa con sus grupos e IDs y tras aplicar verifica que receta y grupos quedaron intactos. Rechaza duplicados. Dry-run por defecto.",
    inputSchema: { cuenta, product_id: z.number().int(), nombre: z.string().min(1).optional(), precio: z.number().min(0).optional(), visible: z.boolean().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => renombrarPlatillo(ctx(extra), a)));

  s.registerTool("renombrar_insumo", {
    title: "Renombrar insumo",
    description: "menu.updateIngredient: cambia solo el nombre de un insumo (conserva categoría, unidad, existencias y recetas que lo usan). Rechaza duplicados; relee y verifica. Dry-run por defecto.",
    inputSchema: { cuenta, ingredient_id: z.number().int(), nombre: z.string().min(1), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => renombrarInsumo(ctx(extra), a)));

}
