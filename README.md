# @egestia/sdk

Cliente de la API pública de Egestia. Le mandas el JSON de una venta y te
devuelve el documento tributario: boleta o factura, con su folio y su estado
frente al SII. Y si a quien le pagas es un prestador y no un cliente, le mandas
el bruto y te devuelve la **boleta de honorarios** con la retención que aplicó
el SII y el líquido a transferir.

El **CAF lo maneja Egestia**, con los folios de ese cliente. Tu sistema no
necesita saber nada del SII: manda la venta y recibe el resultado.

```bash
npm install @egestia/sdk
```

Requiere Node 18 o superior (usa `fetch` nativo). No trae dependencias.

> **¿Cómo funciona por dentro?** En [`docs/`](docs/) está la mecánica:
> [arquitectura](docs/arquitectura.md), [reintentos y folios](docs/reintentos-y-folios.md),
> [estados](docs/estados.md), [problemas](docs/problemas.md),
> [la API por debajo](docs/api-publica.md) y [recetas](docs/recetas.md).

## Empezar

La API key se genera en **Egestia → Integraciones** y empieza con `egst_`.

```ts
import { Egestia } from '@egestia/sdk';

const egestia = new Egestia({
  apiKey: process.env.EGESTIA_API_KEY!,
  appName: 'mi-web/1.0',       // aparece en el log de Egestia
});
```

## Emitir una venta

```ts
const doc = await egestia.documentos.emitir({
  tipo: 'boleta',                    // boleta | boleta_exenta | factura | factura_exenta
  referencia: pedido.id,             // ← IMPORTANTE, ver más abajo
  origen: 'mi-web',

  cliente: {
    name: 'Juan Pérez Soto',
    rut: '12.345.678-5',             // sin RUT se emite a consumidor final
    email: 'juan@correo.cl',
    address: 'Los Aromos 442',       // la FACTURA imprime dirección, ciudad y giro
    city: 'Santiago',
    giro: 'Particular',
  },

  items: [
    { sku: 'PLAN-BASICO', name: 'Plan básico mensual', unitPrice: 19900, quantity: 1, isService: true },
    { sku: 'DOM-CL',      name: 'Dominio .cl',         unitPrice: 9500,  quantity: 2 },
  ],

  pago: { method: 'webpay', amount: 46886 },
});

console.log(doc.folio, doc.status, doc.trackId);
```

Los precios van **netos**: Egestia calcula el IVA.

Con `pago` el documento nace pagado y se manda al SII. Sin `pago`, o con
`emitir: false`, queda en borrador para que alguien lo revise en Egestia.

### El cliente y los productos se crean solos

- **Cliente**: se busca por RUT; si no hay RUT, por correo. Si no existe se crea
  con todo lo que mandes. Si ya existe se reutiliza y se le **completan los
  campos que le falten**, sin pisar lo que el ERP ya tenía.
- **Productos**: se buscan por `sku`. La primera venta de un SKU crea el
  producto en el catálogo; todas las siguientes usan ese mismo. Sin `sku` la
  línea entra como texto suelto y después no se puede saber cuánto se vendió
  de qué.

## `referencia`: lo que evita emitir dos veces

Es el identificador de la venta **en tu sistema**. Mándalo siempre.

Con referencia, repetir la llamada devuelve el documento que ya existe
(`repetido: true`) en vez de emitir otro. Sin ella, un reintento —una cola que
reenvía, un timeout, un usuario que hace doble clic— emite un segundo DTE y
**quema otro folio del CAF** por una venta que ya estaba facturada.

Por eso el SDK sólo reintenta automáticamente cuando hay referencia.

Si dudas de si una venta alcanzó a facturarse:

```ts
const existente = await egestia.documentos.buscarPorReferencia(pedido.id, { origen: 'mi-web' });
if (!existente) await egestia.documentos.emitir({ /* ... */ });
```

## Reintentos: nunca se quema un folio de más

**Un reintento usa el mismo folio. Siempre.** El SDK se encarga, y no necesita
que le pases nada para lograrlo.

Cada envío abre una **interacción** —un identificador que pone el SDK, no tú—.
Si mandas la misma venta otra vez, aunque sea con **los datos corregidos**,
llega la misma interacción y Egestia corrige el documento que ya existe,
conservando su folio:

```ts
// Primer envío: el precio va mal
await egestia.documentos.emitir({ referencia: 'WEB-40001', items: [{ sku: 'X', unitPrice: 0 }], ... });
// → documento 8112790f, folio 5001, rechazado

// Se corrige y se reenvía. Nada especial que hacer.
await egestia.documentos.emitir({ referencia: 'WEB-40001', items: [{ sku: 'X', unitPrice: 120000 }], ... });
// → MISMO documento 8112790f, MISMO folio 5001, con el dato corregido
//    reintento: true · attempts: 2
```

Puedes mirar el registro cuando quieras:

```ts
const i = await egestia.interacciones.ver('mi-web:WEB-40001');
// { id, intentos: 2, documentId, folio: '5001', estado, ultimoProblema }
```

Por defecto el registro vive en memoria. Si tus reintentos ocurren en **otro
proceso** —una cola, un servidor que se reinicia— enchufa algo que persista:

```ts
new Egestia({
  apiKey,
  almacen: {
    async leer(clave)            { return JSON.parse(await redis.get(clave) ?? 'null'); },
    async guardar(clave, inter)  { await redis.set(clave, JSON.stringify(inter)); },
  },
});
```

## Estados: qué se puede corregir y qué no

| Estado | Qué significa | ¿Se puede corregir? |
|---|---|---|
| `draft` | Creado, sin ir al SII | Sí, reenviando |
| `rejected` | El SII lo rechazó | Sí, reenviando — conserva el folio |
| `sent_to_sii` | Enviado, esperando respuesta | No: espera el veredicto |
| `accepted` | **El SII lo aceptó** | **No.** Hay que anular y emitir uno nuevo |
| `reparo` | Aceptado con reparos | No: se corrige con nota de crédito o débito |

Un DTE aceptado existe en el mundo y en el libro de ventas: no hay corrección
posible. **El SDK lo detecta solo** —compara el contenido del envío con el
anterior— y te frena antes de que creas que tu corrección se aplicó:

```
tipo ........ ya_aceptado
mensaje ..... El SII ya aceptó este documento: no admite correcciones.
qué hacer ... Anúlalo con una nota de crédito y emite uno nuevo:
              documentos.anularYReemitir(id, ventaCorregida)
```

Ojo con la diferencia: un reenvío **idéntico** contra un documento aceptado
—la cola que reintenta— no es un error, devuelve el documento tal cual. Sólo se
frena cuando los datos cambiaron, porque ahí sí hay una corrección que no se
puede aplicar.

```ts
const { anulado, emitido } = await egestia.documentos.anularYReemitir(doc.id, ventaCorregida);
```

## Validación con el SII, automática

En la app de Egestia consultar el estado es un botón que alguien aprieta. Por
SDK no hay nadie: `emitir()` hace el ciclo completo —emitir, firmar, enviar al
SII y **preguntar hasta tener respuesta**— y te devuelve el documento ya
resuelto.

```ts
const doc = await egestia.documentos.emitir(venta);
console.log(doc.status);   // accepted | rejected | sent_to_sii (si el SII se demoró)
```

Si emites desde una cola y prefieres no esperar:

```ts
await egestia.documentos.emitir({ ...venta, esperarSii: false });
// y más tarde:
const doc = await egestia.documentos.sincronizar(id);
```

## Quedarse sin folios

Es el problema que detiene la facturación entera, y hasta ahora sólo se notaba
cuando una venta fallaba. Puedes adelantarte:

```ts
const { tipos } = await egestia.folios();
// [{ dteCode: 39, disponibles: 120, desde: 8001, hasta: 8120, cafs: 1 }, ...]

for (const t of tipos) {
  if (t.disponibles < 50) avisar(`Quedan ${t.disponibles} folios del DTE ${t.dteCode}`);
}
```

Y si igual te agarra sin folios, el problema lo dice con todas sus letras:

```
tipo ........ sin_folios
mensaje ..... No hay folios disponibles para este tipo de documento
qué hacer ... Hay que pedir un CAF nuevo al SII y cargarlo en Egestia.
              La venta queda registrada en borrador y se emite sola al reintentar.
documento ... 4f94eb3e…      ← la venta NO se perdió
```

Eso último es lo importante: **sin folios, la venta no se pierde**. El documento
queda creado en borrador y el siguiente reenvío lo emite, con el primer folio
del CAF nuevo.

## Consultar

```ts
const doc = await egestia.documentos.obtener(id);
// → { folio, status, total, trackId, items, contact, ... }

const xml = await egestia.documentos.xml(id);   // DTE firmado, para archivarlo
```

`status` puede ser: `draft` (aún no va al SII), `sent_to_sii` (enviado, sin
respuesta), `accepted`, `rejected`, `reparo`.

El SII no responde al instante. Si necesitas esperar el veredicto:

```ts
const final = await egestia.documentos.emitirYEsperar(venta, { intentos: 10, esperaMs: 3000 });
```

## Anular

En Chile un DTE emitido no se borra: se anula emitiendo una **nota de crédito**
que lo referencia. El SDK lo hace por ti, copiando las líneas y el cliente del
original.

```ts
const nc = await egestia.documentos.anular(doc.id, { motivo: 'Compra devuelta' });
console.log(nc.folio, nc.anulaId);
```

Es idempotente: si el documento ya estaba anulado, devuelve la nota que existía
(`repetido: true`) en vez de emitir una segunda.

Sólo se puede anular lo que ya tiene folio. Un borrador todavía no existe para
el SII: se descarta desde Egestia.

## Boletas de honorarios

Cuando a quien le pagas no es un cliente sino un prestador, el documento no es
una venta: es una **boleta de honorarios de terceros** que la empresa emite
*por cuenta de él*, le retiene al SII lo que corresponde y le transfiere el
resto. Otro registro del SII, y **no gasta folios del CAF**.

```ts
const boleta = await egestia.honorarios.emitir({
  rut: '11.111.111-1',
  nombre: 'Ana Soto',
  bruto: 1_000_000,             // lo que acordaste pagarle
  referencia: pago.id,          // ← IMPORTANTE, más abajo
  origen: 'pagos',
  descripcion: 'Diseño de marca',
  sucursal: 3,                  // a qué sucursal se carga el gasto
});
```

La respuesta trae los tres montos ya resueltos por el SII:

```ts
boleta.folio            // '184'      número de la boleta
boleta.grossAmount      // 1000000    lo que ganó el prestador; lo que él declara
boleta.withholdingRate  // 14.5       la tasa que aplicó el SII, en porcentaje
boleta.withheldAmount   //  145000    lo retiene la empresa y lo entera al SII
boleta.netAmount        //  855000    ← lo ÚNICO que se transfiere

await transferir(boleta.issuer.rut, boleta.netAmount);
```

**Se transfiere `netAmount`, no `grossAmount`.** La diferencia la entera la
empresa al SII: transferirla igual es pagarla dos veces, una al prestador y otra
al fisco.

**Tú mandas el bruto y nada más.** La retención no se calcula por fuera: la
aplica el SII con la tasa vigente para ese receptor, que cambia todos los años.
Emitir con una tasa vieja significa retener de menos y responder por la
diferencia.

### `referencia`: acá pesa más que en una venta

Un DTE duplicado es un folio quemado. Una boleta de honorarios duplicada es una
**retención duplicada** que la empresa declara y entera al SII, y un prestador
con dos boletas a su nombre. Deshacerlo es anular en el SII —con causa, que él
puede reclamar— y rehacer la transferencia.

Con referencia, repetir la llamada devuelve la boleta que ya existe en vez de
emitir otra, y el SDK puede reintentar solo ante un corte de red:

```ts
const boleta = await egestia.honorarios.emitir({ referencia: pago.id, /* ... */ });
if (boleta.repetido) {
  // No se emitió nada: esta referencia ya tenía boleta. Si ya transferiste,
  // no vuelvas a transferir.
}
```

Sin referencia el SDK **no reintenta**, porque un segundo intento sería una
segunda boleta.

Si dudas de si un pago alcanzó a emitir:

```ts
const existente = await egestia.honorarios.buscarPorReferencia(pago.id, { origen: 'pagos' });
if (!existente) await egestia.honorarios.emitir({ /* ... */ });
```

Y si la misma referencia llega con **otro monto**, eso no es un reintento: es
otro pago con la referencia equivocada. El SDK lo frena en vez de devolverte la
boleta vieja —que te haría transferir el líquido de otra prestación—.

### Consultar y anular

```ts
const boleta = await egestia.honorarios.obtener(id);
// → { folio, status, grossAmount, withheldAmount, netAmount, issuer, ... }
```

En el SII una boleta de honorarios **sí se anula** —no hay nota de crédito de
por medio, como en un DTE— pero hay que decir por qué, y el SII ofrece
exactamente dos causas:

```ts
await egestia.honorarios.anular(boleta.id, { causa: 'error_digitacion' });
// 'no_prestacion'    el servicio no se prestó
// 'error_digitacion' la boleta salió con un dato malo
```

Es idempotente: si ya estaba anulada devuelve esa misma (`repetido: true`).
**Anular no devuelve la plata**: si ya transferiste el líquido, eso se arregla
aparte.

### La sucursal

`sucursal` acepta el **número** que sale en el listado de sucursales, o su UUID.
Un honorario es un gasto, y sin sucursal se carga entero a la principal: el
informe por centro de costo queda con una inflada y las otras limpias. Es el
mismo criterio con que los DTE guardan la suya.

### El scope

Emitir boletas de honorarios necesita el scope **`honorarios`**, que va aparte
de `documents`: retener plata de un prestador y enterarla al SII no es lo mismo
que facturar una venta, y una key de tienda no tiene por qué poder hacerlo.

También está `intentarEmitir()` / `intentarAnular()`, con la misma forma que en
documentos: devuelven el problema explicado en vez de lanzarlo.

## Cuando algo falla, el SDK te dice qué pasó

Hay dos formas de trabajar. La que **no lanza** es la recomendada para procesar
ventas, porque el problema viene explicado:

```ts
const r = await egestia.documentos.intentarEmitir(venta);

if (r.ok) {
  await guardarFolio(r.datos.folio);
} else {
  console.error(r.problema.mensaje);   // qué falló
  console.error(r.problema.queHacer);  // qué hacer al respecto

  if (r.problema.documentId) {
    // La venta YA quedó registrada en Egestia. NO reemitir.
    await guardarPendiente(r.problema.documentId);
  }
}
```

El `problema` trae:

| Campo | Qué es |
|---|---|
| `tipo` | `validacion`, `auth`, `scope`, `configuracion`, `sii`, `red`, `no_encontrado`, `servidor` |
| `mensaje` | Lo que respondió Egestia |
| `queHacer` | La salida concreta, en una frase |
| `reintentable` | Si insistir tiene sentido |
| `documentId` | **Si viene, el documento existe pese al error** |
| `sii` | Lo último que respondió el SII |

Ejemplos reales de lo que devuelve:

```
tipo ........ configuracion
mensaje ..... Configure la empresa SII primero (SII > Configuración)
qué hacer ... El cliente no ha configurado sus datos del SII en Egestia.
              El documento YA está creado: reintenta con la MISMA referencia.
documento ... 99eec2cb… (draft)

tipo ........ red
mensaje ..... No se pudo conectar con Egestia: fetch failed
qué hacer ... No hubo respuesta, así que no se sabe si la venta se facturó.
              Antes de reintentar, pregunta con buscarPorReferencia().
```

Los problemas de configuración que reconoce y explica: SII sin configurar,
ambiente no habilitado, **CAF sin folios**, certificado vencido, documento ya
emitido, rechazo del SII.

También está `intentarAnular(id)`, con la misma forma.

## Errores

```ts
import {
  EgestiaValidationError,   // 400 — los datos no pasan la validación
  EgestiaAuthError,         // 401 — la key falta, venció o la revocaron
  EgestiaScopeError,        // 403 — a la key le falta el scope
  EgestiaEmissionError,     // 502 — el documento SE CREÓ pero no se emitió
  EgestiaNetworkError,      // 0   — no llegó o no alcanzó a responder
} from '@egestia/sdk';
```

El importante es `EgestiaEmissionError`. **La venta quedó registrada**: trae
`documentId` y `documentStatus`. Nunca lo resuelvas reintentando a ciegas.

`explicar(error)` convierte cualquiera de estos en el mismo `Problema` de la
sección anterior, por si prefieres `try/catch`:

```ts
import { explicar } from '@egestia/sdk';

try {
  await egestia.documentos.emitir(venta);
} catch (e) {
  const p = explicar(e);
  logger.error({ tipo: p.tipo, mensaje: p.mensaje, documentId: p.documentId });
}
```

```ts
try {
  await egestia.documentos.emitir(venta);
} catch (e) {
  if (e instanceof EgestiaEmissionError) {
    // El documento existe. Guarda el id y revísalo en Egestia; reintentar con
    // la misma referencia devolverá ESE documento, no uno nuevo.
    await guardar({ documentId: e.documentId, estado: e.documentStatus });
  } else if (e instanceof EgestiaValidationError) {
    // Datos malos: repetirlo no lo arregla.
  }
}
```

## Catálogo y stock

Egestia lleva el libro mayor del stock. Tu sistema no lo escribe: pide que se
descuente al cobrar y que se devuelva si el pago se cae.

```ts
const productos = await egestia.productos.listar();
await egestia.productos.guardar({ sku: 'DOM-CL', name: 'Dominio .cl', price: 9500 });

await egestia.stock.comprometer({ reference: pedido.id, items: [{ sku: 'DOM-CL', quantity: 1 }] });
await egestia.stock.liberar({ reference: pedido.id });   // si el pago no se concretó
```

## Configuración

| Opción | Por defecto | Para qué |
|---|---|---|
| `apiKey` | — | La clave `egst_...`. Obligatoria. |
| `baseUrl` | `https://api.egestia.cl/api/pub/v1` | Otra instancia o el entorno local. |
| `timeout` | `30000` | Milisegundos antes de abandonar. |
| `reintentos` | `2` | Sólo aplica a operaciones repetibles. |
| `appName` | — | Se antepone al User-Agent. |
| `fetch` | `globalThis.fetch` | Implementación propia, si el entorno no la trae. |

## Scopes

La key necesita el scope de cada cosa: `documents` para emitir, consultar y
anular boletas y facturas; `honorarios` para las boletas de honorarios de
terceros; `read` para el catálogo; `write` para stock y productos. Una key con
`write` puede todo.

`honorarios` va aparte de `documents` a propósito: emitir por cuenta de un
prestador retiene plata que la empresa entera al SII, y eso no debería venir de
regalo con el permiso de facturar.
