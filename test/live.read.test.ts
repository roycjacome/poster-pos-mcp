// Tests EN VIVO contra cafe-04: lecturas reales + dry-run de cada escritura.
// El cliente envuelve posterHttp y REVIENTA si alguien intenta escribir: aquí nada se aplica.
// Correr con: npm run test:live   (requiere TOKEN_SOURCE=mysql y la DB erp-core-db arriba, o GSM)
import { describe, it, expect } from "vitest";
import { posterHttp, type PosterApi } from "../src/poster.js";
import * as L from "../src/tools/lectura.js";
import * as W from "../src/tools/escritura.js";

const VIVO = process.env.POSTER_LIVE === "1";
const C = "cafe-04";
const soloLectura: PosterApi = {
  get: posterHttp.get,
  post: async (_c, m) => {
    throw new Error(`ESCRITURA BLOQUEADA EN TEST: ${m}`);
  },
};
const ctx = { api: soloLectura, actor: "test-live" };

describe.skipIf(!VIVO)("lecturas cafe-04", () => {
  it("menu_snapshot", async () => {
    const r = await L.menuSnapshot(soloLectura, { cuenta: C });
    expect(r.total_productos).toBeGreaterThan(50);
    expect(r.categorias.length).toBeGreaterThan(3);
    const americano = (await L.menuSnapshot(soloLectura, { cuenta: C, buscar: "americano" })).productos;
    expect(americano.length).toBeGreaterThan(0);
  });
  it("producto_detalle con grupos y precio de opción en pesos", async () => {
    const snap = await L.menuSnapshot(soloLectura, { cuenta: C, limite: 500 });
    const conGrupos = snap.productos.find((p) => p.grupos > 0)!;
    const d = await L.productoDetalle(soloLectura, { cuenta: C, product_id: conGrupos.id });
    expect(d.grupos.length).toBeGreaterThan(0);
    const precios = d.grupos.flatMap((g: any) => g.opciones.map((o: any) => o.precio_pesos));
    expect(precios.every((p: number) => p < 1000)).toBe(true); // pesos, no centavos
  });
  it("insumos y precocinados", async () => {
    const i = await L.insumos(soloLectura, { cuenta: C });
    expect(i.coincidencias).toBeGreaterThan(50);
    const p = await L.precocinados(soloLectura, { cuenta: C });
    expect(p.precocinados.length).toBeGreaterThan(0);
    expect(p.precocinados.some((x) => x.receta.length > 0)).toBe(true);
  });
  it("grupos de clientes, promociones, empleados, métodos de pago, ajustes", async () => {
    expect(Array.isArray((await L.gruposClientes(soloLectura, { cuenta: C })).grupos)).toBe(true);
    expect(Array.isArray((await L.promociones(soloLectura, { cuenta: C, solo_vigentes: true })).promociones)).toBe(true);
    const e = await L.empleados(soloLectura, { cuenta: C });
    expect(e.empleados.length).toBeGreaterThan(0);
    expect(e.puestos.length).toBeGreaterThan(0);
    expect((await L.metodosPago(soloLectura, { cuenta: C })).metodos.length).toBeGreaterThan(0);
    expect((await L.ajustes(soloLectura, { cuenta: C })).ajustes).toHaveProperty("COMPANY_ID");
  });
  it("compras: lista en centavos → pesos cuadra con el detalle en pesos", async () => {
    const lista = await L.compras(soloLectura, { cuenta: C, limite: 5 });
    expect(lista.compras.length).toBeGreaterThan(0);
    const c0 = lista.compras[0];
    const d = await L.compraDetalle(soloLectura, { cuenta: C, supply_id: c0.id });
    expect(Math.abs(d.total_pesos - c0.total_pesos)).toBeLessThan(0.5);
    const suma = d.renglones.reduce((s: number, r: any) => s + r.importe_pesos, 0);
    expect(Math.abs(suma - d.total_pesos)).toBeLessThan(0.5);
  });
  it("saldos y catálogos base", async () => {
    expect((await L.saldos(soloLectura, { cuenta: C })).coincidencias).toBeGreaterThan(50);
    const b = await L.catalogosBase(soloLectura, { cuenta: C });
    expect(b.almacenes.length).toBeGreaterThan(0);
    expect(b.proveedores.length).toBeGreaterThan(0);
  });
  it("poster_get solo acepta get*", async () => {
    expect((await L.posterGet(soloLectura, { cuenta: C, metodo: "menu.getCategories" })).bytes).toBeGreaterThan(10);
    await expect(L.posterGet(soloLectura, { cuenta: C, metodo: "menu.updateDish" })).rejects.toThrow(/lectura/);
  });
});

describe.skipIf(!VIVO)("dry-run de escrituras en cafe-04 (sin aplicar)", () => {
  it("actualizar_platillo: ocultar un platillo sin receta", async () => {
    const snap = await L.menuSnapshot(soloLectura, { cuenta: C, limite: 500 });
    const p = snap.productos.find((x) => x.tipo === 2 && x.receta_lineas === 0 && x.visible)!;
    const r: any = await W.actualizarPlatillo(ctx, { cuenta: C, product_id: p.id, visible: false });
    expect(r.modo).toBe("dry-run");
    expect(r.cambios.every((c: any) => c.campo.startsWith("visible."))).toBe(true);
  });
  it("actualizar_platillo rechaza platillo con receta", async () => {
    const snap = await L.menuSnapshot(soloLectura, { cuenta: C, limite: 500 });
    const p = snap.productos.find((x) => x.tipo === 2 && x.receta_lineas > 0);
    if (!p) return;
    await expect(W.actualizarPlatillo(ctx, { cuenta: C, product_id: p.id, visible: false })).rejects.toThrow(/tiene receta/);
  });
  it("actualizar_categoria, actualizar_precocinado (sin cambios = diff vacío)", async () => {
    const snap = await L.menuSnapshot(soloLectura, { cuenta: C });
    const cat: any = await W.actualizarCategoria(ctx, { cuenta: C, category_id: snap.categorias[0].id, nombre: `${snap.categorias[0].nombre} (prueba)` });
    expect(cat.cambios).toHaveLength(1);
    const pp = (await L.precocinados(soloLectura, { cuenta: C })).precocinados.find((x) => x.receta.length)!;
    const r: any = await W.actualizarPrecocinado(ctx, { cuenta: C, product_id: pp.id });
    expect(r.cambios).toEqual([]);
    expect(r.payload.ingredient.every((l: any) => typeof l.id === "number" && ["g", "ml", "p"].includes(l.unit))).toBe(true);
  });
  it("crear_insumo, crear_compra y grupos de clientes", async () => {
    const b = await L.catalogosBase(soloLectura, { cuenta: C });
    const ins: any = await W.crearInsumo(ctx, { cuenta: C, nombre: `zz prueba mcp ${Date.now()}`, categoria_id: b.categorias_insumos[0].id, unidad: "kg" });
    expect(ins.modo).toBe("dry-run");
    const unInsumo = (await L.insumos(soloLectura, { cuenta: C, limite: 1 })).insumos[0];
    const comp: any = await W.crearCompra(ctx, { cuenta: C, storage_id: b.almacenes[0].id, supplier_id: b.proveedores[0].id, comentario: "dry-run mcp", renglones: [{ id: unInsumo.id, cantidad: 2, costo_unitario: 50 }] });
    expect(comp.payload.ingredients[0]).toMatchObject({ id: unInsumo.id, type: 4, num: 2, sum: 5000 });
    const g: any = await W.crearGrupoCliente(ctx, { cuenta: C, nombre: `zz grupo mcp ${Date.now()}`, tipo: "descuento", porcentaje: 10 });
    expect(g.payload.loyalty_type).toBe(2);
    const grupos = (await L.gruposClientes(soloLectura, { cuenta: C })).grupos;
    if (grupos[0]) {
      const u: any = await W.actualizarGrupoCliente(ctx, { cuenta: C, client_groups_id: grupos[0].id, porcentaje: grupos[0].porcentaje + 1 });
      expect(u.cambios).toEqual([{ campo: "client_groups_discount", antes: grupos[0].porcentaje, despues: grupos[0].porcentaje + 1 }]);
    }
  });
  it("otra cuenta sin flag se bloquea antes de leer", async () => {
    await expect(W.crearInsumo(ctx, { cuenta: "cafe-01", nombre: "x", categoria_id: 1, unidad: "kg" })).rejects.toThrow(/bloqueada/);
  });
});
