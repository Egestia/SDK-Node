# Recetas

Cómo se ve esto en una integración de verdad.

## Una venta en una tienda web

```ts
import { Egestia } from '@egestia/sdk';

const egestia = new Egestia({
  apiKey: process.env.EGESTIA_API_KEY!,
  appName: 'mi-tienda/1.0',
});

export async function facturar(pedido) {
  const r = await egestia.documentos.intentarEmitir({
    tipo: pedido.necesitaFactura ? 'factura' : 'boleta',
    referencia: pedido.id,          // el id del pedido: la llave de todo
    origen: 'mi-tienda',

    cliente: {
      name: pedido.cliente.nombre,
      rut: pedido.cliente.rut,      // sin RUT → boleta a consumidor final
      email: pedido.cliente.email,
      address: pedido.cliente.direccion,
      city: pedido.cliente.ciudad,
      giro: pedido.cliente.giro,    // la factura lo imprime
    },

    items: pedido.lineas.map((l) => ({
      sku: l.sku,                   // arma el catálogo solo
      name: l.nombre,
      unitPrice: l.precioNeto,      // NETO: el IVA lo calcula Egestia
      quantity: l.cantidad,
      isService: l.esServicio,
    })),

    pago: { method: pedido.medioDePago, amount: pedido.totalPagado },
  });

  if (r.ok) {
    await pedido.guardar({ folio: r.datos.folio, documentId: r.datos.id, estado: r.datos.status });
    return r.datos;
  }

  // Falló. Lo primero: ¿quedó creado igual?
  if (r.problema.documentId) {
    await pedido.guardar({ documentId: r.problema.documentId, estado: 'pendiente' });
  }
  await avisarAlEquipo(r.problema.tipo, r.problema.mensaje, r.problema.queHacer);
  throw new Error(r.problema.mensaje);
}
```

Lo que hace que esto sea robusto: **la `referencia` es el id del pedido**.
Llamar a `facturar(pedido)` dos veces no emite dos documentos.

## Una cola que reintenta

Emite sin esperar al SII y resuelve el veredicto aparte:

```ts
// al procesar el trabajo
const r = await egestia.documentos.intentarEmitir({ ...venta, esperarSii: false });

if (!r.ok && r.problema.reintentable) {
  throw new Error(r.problema.mensaje);   // que la cola lo reintente: es seguro
}

// más tarde, otro trabajo revisa los que quedaron en camino
for (const p of await pedidosEn('sent_to_sii')) {
  const doc = await egestia.documentos.sincronizar(p.documentId);
  if (doc.status !== 'sent_to_sii') await p.guardar({ estado: doc.status, folio: doc.folio });
}
```

Si la cola corre en **otro proceso** que el que emitió, persiste el registro:

```ts
new Egestia({
  apiKey,
  almacen: {
    async leer(clave)           { return JSON.parse(await redis.get(`egestia:${clave}`) ?? 'null'); },
    async guardar(clave, inter) { await redis.set(`egestia:${clave}`, JSON.stringify(inter)); },
  },
});
```

## Recuperarse de un corte

No sabes si la venta alcanzó a facturarse:

```ts
const existente = await egestia.documentos.buscarPorReferencia(pedido.id, { origen: 'mi-tienda' });

if (existente) {
  await pedido.guardar({ folio: existente.folio, estado: existente.status });
} else {
  await facturar(pedido);
}
```

## Una devolución

```ts
const nc = await egestia.documentos.anular(pedido.documentId, {
  motivo: 'Producto devuelto por el cliente',
});
await pedido.guardar({ anulado: true, notaCredito: nc.folio });
```

Si el pedido se corrige en vez de anularse:

```ts
const { anulado, emitido } = await egestia.documentos.anularYReemitir(
  pedido.documentId,
  { ...ventaCorregida, referencia: `${pedido.id}-v2` },
);
```

## Pagarle a un prestador: emitir y transferir el líquido

El orden importa. Primero se emite —ahí el SII dice cuánto se retiene— y recién
después se transfiere, porque hasta que la boleta no existe no se sabe el monto.

```ts
export async function pagarHonorario(pago) {
  const r = await egestia.honorarios.intentarEmitir({
    rut: pago.prestador.rut,
    nombre: pago.prestador.nombre,
    bruto: pago.montoAcordado,       // el BRUTO. La retención la pone el SII
    referencia: pago.id,             // la llave de todo
    origen: 'pagos',
    descripcion: pago.glosa,
    sucursal: pago.sucursal,         // a qué centro de costo se carga
  });

  if (!r.ok) {
    // `en_curso`: hay otra llamada emitiendo esta misma referencia ahora mismo.
    // No emitas otra: deja que la cola lo reintente.
    if (r.problema.reintentable) throw new Error(r.problema.mensaje);

    await avisarAlEquipo(r.problema.tipo, r.problema.mensaje, r.problema.queHacer);
    return null;
  }

  const boleta = r.datos;

  // Ya existía: esta llamada no emitió nada. Si la transferencia de ese pago ya
  // salió, no vuelve a salir.
  if (boleta.repetido && pago.transferenciaId) return boleta;

  await pago.guardar({
    boletaId: boleta.id,
    folio: boleta.folio,
    bruto: boleta.grossAmount,
    retenido: boleta.withheldAmount,   // esto lo entera la empresa al SII
    liquido: boleta.netAmount,
  });

  // Lo que se transfiere es el LÍQUIDO. Transferir el bruto es pagar la
  // retención dos veces: una al prestador y otra al fisco.
  await transferir({ rut: boleta.issuer.rut, monto: boleta.netAmount, glosa: `Boleta ${boleta.folio}` });

  return boleta;
}
```

### Si la transferencia falla después de emitir

La boleta ya existe en el SII y no hay que reemitirla. Se reintenta **sólo la
transferencia**, y el monto se lee de la boleta, no se recalcula:

```ts
const boleta = await egestia.honorarios.buscarPorReferencia(pago.id, { origen: 'pagos' });
if (boleta && boleta.status === 'vigente') {
  await transferir({ rut: boleta.issuer.rut, monto: boleta.netAmount, glosa: `Boleta ${boleta.folio}` });
}
```

### Si el pago se cae antes de transferir

```ts
await egestia.honorarios.anular(boleta.id, { causa: 'no_prestacion' });
```

Si ya se transfirió, anular **no** devuelve la plata: la boleta queda anulada
ante el SII y el reembolso se gestiona aparte.

## Avisar antes de quedarse sin folios

Un trabajo diario que evita el peor día del mes:

```ts
const { tipos } = await egestia.folios();

for (const t of tipos) {
  if (t.disponibles === 0)      await alertar('crítico', `Sin folios del DTE ${t.dteCode}: no se puede facturar`);
  else if (t.disponibles < 100) await alertar('aviso',   `Quedan ${t.disponibles} folios del DTE ${t.dteCode}`);
}
```

## Guardar el XML

El DTE firmado es lo que vale ante el SII. Conviene archivarlo:

```ts
const xml = await egestia.documentos.xml(doc.id);
await almacenamiento.guardar(`dte/${doc.folio}.xml`, xml);
```

## Probar sin emitir

Con `emitir: false` el documento queda en borrador y el SII no se entera. Sirve
para desarrollo y para cargar ventas históricas:

```ts
await egestia.documentos.emitir({ ...venta, emitir: false });
```

Para pruebas de verdad contra el SII, el cliente debe tener su ambiente en
**certificación** con un CAF de certificación cargado. Eso se configura en
Egestia, no en el SDK.
