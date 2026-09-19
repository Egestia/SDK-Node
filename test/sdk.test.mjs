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

// ── Boletas de honorarios de terceros ────────────────────────────────────────
//
// Lo que se prueba acá es lo que distingue una boleta de honorarios de una
// venta: que el líquido llegue separado del bruto, que sin referencia el SDK no
// reintente —una boleta de más es una retención de más— y que un monto distinto
// sobre la misma referencia se explique en vez de devolver la boleta vieja.

const BOLETA = {
  id: 'h1',
  folio: '184',
  status: 'vigente',
  kind: 'emitida',
  issuer: { rut: '11.111.111-1', name: 'Ana Soto', contactId: 'c1' },
  issueDate: '2026-09-17',
  period: '202609',
  description: 'Diseño de marca',
  grossAmount: 1000000,
  withholdingRate: 14.5,
  withheldAmount: 145000,
  netAmount: 855000,
  siiCode: 'ABC123',
  branchId: null,
  reference: 'PAGO-77',
  source: 'pagos',
};

const HONORARIO = {
  rut: '11.111.111-1',
  nombre: 'Ana Soto',
  bruto: 1000000,
  referencia: 'PAGO-77',
  origen: 'pagos',
  descripcion: 'Diseño de marca',
};

test('el líquido a transferir viene aparte del bruto', async () => {
  const { cliente } = clienteCon(() => respuesta({ data: BOLETA }));
  const boleta = await cliente.honorarios.emitir(HONORARIO);

  assert.equal(boleta.grossAmount, 1000000);
  assert.equal(boleta.withheldAmount, 145000);
  // Lo que se transfiere. Si esto fuera el bruto, se pagaría la retención dos
  // veces: una al prestador y otra al SII.
  assert.equal(boleta.netAmount, 855000);
  assert.equal(boleta.withheldAmount + boleta.netAmount, boleta.grossAmount);
});

test('manda el BRUTO, no una retención calculada por fuera', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: BOLETA }));
  await cliente.honorarios.emitir(HONORARIO);

  assert.equal(llamadas[0].body.grossAmount, 1000000);
  assert.equal(llamadas[0].body.withheldAmount, undefined);
  assert.equal(llamadas[0].body.withholdingRate, undefined);
});

test('la sucursal viaja como la manda quien emite', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: BOLETA }));
  await cliente.honorarios.emitir({ ...HONORARIO, sucursal: 3 });

  assert.equal(llamadas[0].body.branchId, 3);
});

test('sin referencia NO reintenta: un reintento sería otra boleta ante el SII', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ error: 'caída' }, 500), { reintentos: 3 });

  await assert.rejects(() => cliente.honorarios.emitir({ ...HONORARIO, referencia: undefined }));
  assert.equal(llamadas.length, 1, 'no debe insistir sin referencia');
});

test('con referencia sí reintenta: Egestia devuelve la que ya emitió', async () => {
  const { cliente, llamadas } = clienteCon(
    (n) => (n === 1 ? respuesta({ error: 'caída' }, 500) : respuesta({ data: BOLETA })),
    { reintentos: 2 },
  );

  const boleta = await cliente.honorarios.emitir(HONORARIO);
  assert.equal(llamadas.length, 2);
  assert.equal(boleta.folio, '184');
});

test('la misma referencia con OTRO monto se explica, no se devuelve la vieja', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'La referencia «PAGO-77» ya emitió una boleta por $1000000, y ahora se pide por $500000.',
    data: { ...BOLETA, repetido: true },
  }, 409));

  const r = await cliente.honorarios.intentarEmitir({ ...HONORARIO, bruto: 500000 });

  assert.equal(r.ok, false);
  assert.equal(r.problema.tipo, 'ya_emitida');
  assert.match(r.problema.queHacer, /anúlala/i);
  // La boleta que sí existe viaja en el detalle: sin esto, quien integra no
  // sabe cuánto se emitió de verdad ni cuánto transferir.
  assert.equal(r.problema.detalle.data.netAmount, 855000);
});

test('«se está emitiendo ahora mismo» es reintentable, no un error de datos', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'Ya se está emitiendo la boleta de la referencia «PAGO-77».',
  }, 409));

  const r = await cliente.honorarios.intentarEmitir(HONORARIO);
  assert.equal(r.problema.tipo, 'en_curso');
  assert.equal(r.problema.reintentable, true);
  assert.match(r.problema.queHacer, /buscarPorReferencia/);
});

test('la clave tributaria que falta no se confunde con un certificado vencido', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'Acme SpA no tiene clave tributaria. Se configura en Configuración → SII → Certificado Digital.',
  }, 400));

  const r = await cliente.honorarios.intentarEmitir(HONORARIO);
  assert.equal(r.problema.tipo, 'configuracion');
  assert.match(r.problema.queHacer, /clave tributaria/i);
});

test('buscar por referencia devuelve null cuando el pago aún no emitió boleta', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: null }));
  const boleta = await cliente.honorarios.buscarPorReferencia('PAGO-99', { origen: 'pagos' });

  assert.equal(boleta, null);
  assert.match(llamadas[0].url, /reference=PAGO-99/);
  assert.match(llamadas[0].url, /source=pagos/);
});

test('anular exige la causa antes de salir a la red', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: BOLETA }));

  await assert.rejects(() => cliente.honorarios.anular('h1', {}), /no_prestacion/);
  assert.equal(llamadas.length, 0);
});

test('anular dos veces devuelve la misma boleta anulada', async () => {
  const { cliente } = clienteCon(() => respuesta({
    data: { ...BOLETA, status: 'anulada', repetido: true },
  }));

  const boleta = await cliente.honorarios.anular('h1', { causa: 'error_digitacion' });
  assert.equal(boleta.status, 'anulada');
  assert.equal(boleta.repetido, true);
});

test('valida el monto antes de salir a la red', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: BOLETA }));

  await assert.rejects(() => cliente.honorarios.emitir({ ...HONORARIO, bruto: 0 }), /bruto/);
  await assert.rejects(() => cliente.honorarios.emitir({ ...HONORARIO, rut: '' }), /RUT/);
  assert.equal(llamadas.length, 0);
});

test('el registro cuenta los intentos de un pago, sin mezclarlo con una venta', async () => {
  const almacen = new AlmacenEnMemoria();
  const { cliente } = clienteCon(() => respuesta({ data: BOLETA }), { almacen });

  await cliente.honorarios.emitir(HONORARIO);
  await cliente.honorarios.emitir(HONORARIO);

  const delPago = await cliente.interacciones.ver('honorarios:pagos:PAGO-77');
  assert.equal(delPago.intentos, 2);
  // Una venta con el mismo número en el mismo origen es otra cosa.
  assert.equal(await cliente.interacciones.ver('pagos:PAGO-77'), null);
});

// ── Facturas de compra por servicios del exterior (DTE 46) ───────────────────
//
// Lo propio de este documento: se manda el NETO en la moneda del pago, el IVA se
// recarga y se retiene entero —así que el total vuelve a ser el neto— y lo que se
// le transfiere al prestador es lo pactado, no el total del DTE en pesos.

const FACTURA_COMPRA = {
  id: 'fc1',
  folio: '87',
  status: 'enviada',
  dteCode: 46,
  supplier: { rut: '55555555-5', name: 'Jane Doe', country: 'US', contactId: 'c9' },
  issueDate: '2026-09-18',
  period: '202609',
  currency: 'USD',
  amount: 1000,
  exchangeRate: 980.5,
  net: 980500,
  tax: 186295,
  withheld: 186295,
  total: 980500,
  items: [{ description: 'Contenido de septiembre', quantity: 1, unitPrice: 1000, amount: 1000, amountClp: 980500 }],
  invoiceNumber: null,
  trackId: '9911',
  reference: 'PAY-501',
  source: 'secretsaccess',
  avisos: [],
};

const PAGO_CREADOR = {
  nombre: 'Jane Doe',
  pais: 'US',
  monto: 1000,
  moneda: 'USD',
  referencia: 'PAY-501',
  origen: 'secretsaccess',
  descripcion: 'Contenido de septiembre',
};

test('el IVA se retiene entero: el total del documento es el neto', async () => {
  const { cliente } = clienteCon(() => respuesta({ data: FACTURA_COMPRA }));
  const f = await cliente.facturasCompra.emitir(PAGO_CREADOR);

  assert.equal(f.net, 980500);
  assert.equal(f.withheld, f.tax, 'lo retenido es el IVA completo');
  // neto + IVA − IVA retenido = neto
  assert.equal(f.net + f.tax - f.withheld, f.total);
});

test('lo que se le transfiere al creador es lo pactado en su moneda', async () => {
  const { cliente } = clienteCon(() => respuesta({ data: FACTURA_COMPRA }));
  const f = await cliente.facturasCompra.emitir(PAGO_CREADOR);

  assert.equal(f.amount, 1000);
  assert.equal(f.currency, 'USD');
  // Y el neto en pesos es eso mismo convertido, no otro monto.
  assert.equal(f.net, Math.round(f.amount * f.exchangeRate));
});

test('manda el NETO, sin IVA ni tipo de cambio calculados por fuera', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: FACTURA_COMPRA }));
  await cliente.facturasCompra.emitir(PAGO_CREADOR);

  assert.equal(llamadas[0].body.amount, 1000);
  assert.equal(llamadas[0].body.currency, 'USD');
  // El tipo de cambio lo resuelve el servidor con el valor del día.
  assert.equal(llamadas[0].body.exchangeRate, null);
  assert.equal(llamadas[0].body.tax, undefined);
});

test('sin referencia NO reintenta: un reintento sería otro DTE 46', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ error: 'caída' }, 500), { reintentos: 3 });

  await assert.rejects(() => cliente.facturasCompra.emitir({ ...PAGO_CREADOR, referencia: undefined }));
  assert.equal(llamadas.length, 1);
});

test('el registro no mezcla el pago de un creador con una venta del mismo número', async () => {
  const almacen = new AlmacenEnMemoria();
  const { cliente } = clienteCon(() => respuesta({ data: FACTURA_COMPRA }), { almacen });

  await cliente.facturasCompra.emitir(PAGO_CREADOR);
  await cliente.facturasCompra.emitir(PAGO_CREADOR);

  const r = await cliente.interacciones.ver('facturas-compra:secretsaccess:PAY-501');
  assert.equal(r.intentos, 2);
  assert.equal(await cliente.interacciones.ver('secretsaccess:PAY-501'), null);
});

test('la factura que quedó en borrador viene con su id: NO reemitir', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'Factura creada pero no emitida: No hay CAF de factura de compra (tipo 46) para el folio 87.',
    data: { ...FACTURA_COMPRA, status: 'borrador', folio: null, id: 'fc9' },
  }, 502));

  const r = await cliente.facturasCompra.intentarEmitir(PAGO_CREADOR);

  assert.equal(r.ok, false);
  assert.equal(r.problema.tipo, 'sin_folios');
  assert.equal(r.problema.documentId, 'fc9', 'la factura existe: el reintento debe encontrarla');
  assert.match(r.problema.queHacer, /tipo 46/);
});

test('el CAF del 46 no se confunde con el de las facturas de venta', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'No hay CAF de factura de compra (tipo 46) para el folio 5. Súbelo en SII > Folios.',
  }, 409));

  const r = await cliente.facturasCompra.intentarEmitir(PAGO_CREADOR);
  assert.equal(r.problema.tipo, 'sin_folios');
  assert.match(r.problema.queHacer, /distinto del de las facturas de venta/);
});

test('sin tipo de cambio se puede reintentar, y no se inventa un dólar', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'No tenemos el valor de USD para el 2026-09-18 ni para los siete días anteriores.',
  }, 409));

  const r = await cliente.facturasCompra.intentarEmitir(PAGO_CREADOR);
  assert.equal(r.problema.tipo, 'sin_tipo_cambio');
  assert.equal(r.problema.reintentable, true);
  assert.match(r.problema.queHacer, /MISMA referencia/);
});

test('la misma referencia con otro monto se frena', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'La referencia «PAY-501» ya emitió una factura por 1000 USD, y ahora se pide por 500 USD.',
    data: { ...FACTURA_COMPRA, repetido: true },
  }, 409));

  const r = await cliente.facturasCompra.intentarEmitir({ ...PAGO_CREADOR, monto: 500 });
  assert.equal(r.problema.tipo, 'ya_emitida');
  assert.equal(r.problema.detalle.data.amount, 1000);
});

test('«se está emitiendo ahora mismo» también aplica a la factura', async () => {
  const { cliente } = clienteCon(() => respuesta({
    error: 'Ya se está emitiendo la factura de compra de la referencia «PAY-501».',
  }, 409));

  const r = await cliente.facturasCompra.intentarEmitir(PAGO_CREADOR);
  assert.equal(r.problema.tipo, 'en_curso');
  assert.equal(r.problema.reintentable, true);
});

test('buscar por referencia devuelve null si ese pago aún no emitió', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: null }));
  const f = await cliente.facturasCompra.buscarPorReferencia('PAY-777', { origen: 'secretsaccess' });

  assert.equal(f, null);
  assert.match(llamadas[0].url, /reference=PAY-777/);
});

test('valida antes de salir a la red', async () => {
  const { cliente, llamadas } = clienteCon(() => respuesta({ data: FACTURA_COMPRA }));

  await assert.rejects(() => cliente.facturasCompra.emitir({ ...PAGO_CREADOR, nombre: '' }), /nombre/);
  await assert.rejects(() => cliente.facturasCompra.emitir({ ...PAGO_CREADOR, monto: 0 }), /monto/);
  assert.equal(llamadas.length, 0);

  // Con detalle no hace falta `monto`.
  await cliente.facturasCompra.emitir({
    ...PAGO_CREADOR, monto: undefined,
    items: [{ descripcion: 'Contenido', cantidad: 1, precioUnitario: 1000 }],
  });
  assert.equal(llamadas.length, 1);
});

test('emitirYEsperar pregunta hasta que el SII deje de estar en camino', async () => {
  const { cliente, llamadas } = clienteCon((n) => {
    if (n === 1) return respuesta({ data: FACTURA_COMPRA });                       // enviada
    if (n === 2) return respuesta({ data: { ...FACTURA_COMPRA, status: 'enviada' } });
    return respuesta({ data: { ...FACTURA_COMPRA, status: 'aceptada' } });
  });

  const f = await cliente.facturasCompra.emitirYEsperar(PAGO_CREADOR, { intentos: 4, esperaMs: 1 });
  assert.equal(f.status, 'aceptada');
  assert.ok(llamadas.length >= 3);
  assert.match(llamadas[1].url, /\/facturas-compra\/fc1\/verificar$/);
});
