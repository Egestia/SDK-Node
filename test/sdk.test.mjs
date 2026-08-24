/**
 * Pruebas del SDK sin servidor: se le pasa un `fetch` de mentira y se comprueba
 * lo que el SDK hace con la respuesta. Lo que se prueba acá es la lógica que le
 * pertenece al SDK —interacciones, reintentos, diagnóstico— y no la API, que
 * tiene las suyas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Egestia,
  AlmacenEnMemoria,
  EgestiaAuthError,
  EgestiaEmissionError,
  EgestiaNetworkError,
  explicar,
} from '../dist/index.js';

const respuesta = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const clienteCon = (handler, opts = {}) => {
  const llamadas = [];
  const cliente = new Egestia({
    apiKey: 'egst_prueba',
    baseUrl: 'https://api.ejemplo/api/pub/v1',
    reintentos: 0,
    ...opts,
    fetch: async (url, init) => {
      llamadas.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
      return handler(llamadas.length, { url, init });
    },
  });
  return { cliente, llamadas };
};

const VENTA = {
  tipo: 'boleta',
  referencia: 'P-1',
  cliente: { name: 'Cliente Uno' },
  items: [{ sku: 'A', unitPrice: 1000 }],
  emitir: false,
};

test('manda la API key en el header', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: { id: 'd1', status: 'draft' } }));
  await cliente.documentos.emitir(VENTA);
  assert.equal(llamadas[0].headers['x-api-key'], 'egst_prueba');
});

test('el SDK pone la interacción sin que se la den', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: { id: 'd1', status: 'draft' } }));
  await cliente.documentos.emitir(VENTA);

  const interaccion = llamadas[0].body.interactionId;
  assert.ok(interaccion, 'debe viajar una interacción');
  assert.match(interaccion, /^int_/);
});

test('el reenvío de la misma venta lleva la MISMA interacción', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: { id: 'd1', status: 'draft' } }));
  await cliente.documentos.emitir(VENTA);
  await cliente.documentos.emitir({ ...VENTA, items: [{ sku: 'A', unitPrice: 2000 }] });

  assert.equal(llamadas[0].body.interactionId, llamadas[1].body.interactionId);
});

test('dos ventas distintas llevan interacciones distintas', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: { id: 'd1', status: 'draft' } }));
  await cliente.documentos.emitir(VENTA);
  await cliente.documentos.emitir({ ...VENTA, referencia: 'P-2' });

  assert.notEqual(llamadas[0].body.interactionId, llamadas[1].body.interactionId);
});

test('cuenta los intentos en el registro', async () => {
  const almacen = new AlmacenEnMemoria();
  const { cliente } = clienteCon(() => respuesta({ data: { id: 'd1', status: 'draft' } }), { almacen });
  await cliente.documentos.emitir(VENTA);
  await cliente.documentos.emitir(VENTA);
  await cliente.documentos.emitir(VENTA);

  const registro = await cliente.interacciones.ver('sdk:P-1');
  assert.equal(registro.intentos, 3);
  assert.equal(registro.documentId, 'd1');
});

test('corregir un documento ya aceptado se frena', async () => {
  const { cliente } = clienteCon(() =>
    respuesta({ data: { id: 'd1', status: 'accepted', repetido: true, corregible: false,
                        motivoNoCorregible: 'El SII ya aceptó este documento.' } }));

  await cliente.documentos.emitir(VENTA);                       // primer envío
  const r = await cliente.documentos.intentarEmitir({ ...VENTA, items: [{ sku: 'A', unitPrice: 9999 }] });

  assert.equal(r.ok, false);
  assert.equal(r.problema.tipo, 'ya_aceptado');
  assert.match(r.problema.queHacer, /anularYReemitir/);
});

test('el reenvío IDÉNTICO contra un aceptado no es error', async () => {
  const { cliente } = clienteCon(() =>
    respuesta({ data: { id: 'd1', status: 'accepted', repetido: true, corregible: false } }));

  await cliente.documentos.emitir(VENTA);
  const r = await cliente.documentos.intentarEmitir(VENTA);     // mismos datos

  assert.equal(r.ok, true, 'una cola que reintenta no debe recibir un error');
});

test('el 502 de emisión trae el documento que quedó creado', async () => {
  const { cliente } = clienteCon(() =>
    respuesta({ error: 'Documento creado pero no emitido: No hay folios disponibles',
                data: { id: 'd9', status: 'draft', motivo: 'No hay folios disponibles para este tipo de documento' } }, 502));

  const r = await cliente.documentos.intentarEmitir({ ...VENTA, emitir: true });
  assert.equal(r.ok, false);
  assert.equal(r.problema.tipo, 'sin_folios');
  assert.equal(r.problema.documentId, 'd9');
  assert.equal(r.problema.reintentable, false, 'no se reintenta a ciegas: el documento ya existe');
});

test('sin folios: la venta no se pierde y el registro lo anota', async () => {
  const almacen = new AlmacenEnMemoria();
  const { cliente } = clienteCon(() =>
    respuesta({ error: 'Documento creado pero no emitido: No hay folios disponibles',
                data: { id: 'd9', status: 'draft', motivo: 'No hay folios disponibles' } }, 502), { almacen });

  await cliente.documentos.intentarEmitir({ ...VENTA, emitir: true });
  const registro = await cliente.interacciones.ver('sdk:P-1');
  assert.equal(registro.documentId, 'd9');
  assert.match(registro.ultimoProblema, /folios/);
});

test('una key inválida se distingue de un problema de datos', async () => {
  const { cliente } = clienteCon(() => respuesta({ error: 'API key inválida o expirada' }, 401));
  const r = await cliente.documentos.intentarEmitir(VENTA);
  assert.equal(r.problema.tipo, 'auth');
});

test('sin respuesta, avisa que hay que preguntar antes de reintentar', async () => {
  const { cliente } = clienteCon(() => { throw new Error('connect ECONNREFUSED'); });
  const r = await cliente.documentos.intentarEmitir(VENTA);

  assert.equal(r.problema.tipo, 'red');
  assert.match(r.problema.queHacer, /buscarPorReferencia/);
});

test('reintenta los fallos de servidor, no los de datos', async () => {
  const servidor = clienteCon((n) => n === 1
    ? respuesta({ error: 'Boom' }, 500)
    : respuesta({ data: { id: 'd1', status: 'draft' } }), { reintentos: 1 });
  await servidor.cliente.documentos.emitir(VENTA);
  assert.equal(servidor.llamadas.length, 2, 'un 500 se reintenta');

  const datos = clienteCon(() => respuesta({ error: 'Tipo inválido' }, 400), { reintentos: 3 });
  await datos.cliente.documentos.intentarEmitir(VENTA);
  assert.equal(datos.llamadas.length, 1, 'un 400 no mejora repitiéndolo');
});

test('`{ data: null }` se devuelve como null, no como el sobre', async () => {
  const { cliente } = clienteCon(() => respuesta({ data: null }));
  const doc = await cliente.documentos.buscarPorReferencia('no-existe');
  assert.equal(doc, null);
});

test('espera al SII hasta que deje de estar en camino', async () => {
  const { cliente, llamadas } = clienteCon((n) => {
    if (n === 1) return respuesta({ data: { id: 'd1', status: 'sent_to_sii' } });
    if (n === 2) return respuesta({ data: { id: 'd1', status: 'sent_to_sii' } });
    return respuesta({ data: { id: 'd1', status: 'accepted', folio: '77' } });
  });

  const doc = await cliente.documentos.emitir({ ...VENTA, emitir: true, esperarSii: true });
  assert.equal(doc.status, 'accepted');
  assert.ok(llamadas.length >= 3, 'debe haber preguntado al SII por su cuenta');
  assert.match(llamadas[1].url, /\/sync$/);
});

test('explicar() sirve también desde un catch', () => {
  assert.equal(explicar(new EgestiaAuthError('mala key', 401)).tipo, 'auth');
  assert.equal(explicar(new EgestiaNetworkError('sin red')).reintentable, true);
  assert.equal(explicar(new EgestiaEmissionError('no emitido', 'd1', 'draft')).documentId, 'd1');
});

test('valida antes de salir a la red', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: {} }));
  await assert.rejects(() => cliente.documentos.emitir({ ...VENTA, items: [] }), /al menos un ítem/);
  assert.equal(llamadas.length, 0, 'no debe llamar a la API con datos que ya se sabe que están mal');
});
