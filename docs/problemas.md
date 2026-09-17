# Problemas

El SDK no devuelve «error 502». Devuelve **qué pasó, qué hacer, y si el
documento quedó creado igual**.

```ts
const r = await egestia.documentos.intentarEmitir(venta);

if (!r.ok) {
  r.problema.tipo         // qué clase de problema es
  r.problema.mensaje      // lo que respondió Egestia
  r.problema.queHacer     // la salida, en una frase
  r.problema.reintentable // si insistir sirve de algo
  r.problema.documentId   // si viene, EL DOCUMENTO EXISTE
  r.problema.sii          // lo último que dijo el SII
}
```

Con `try/catch` es lo mismo: `explicar(error)` devuelve el mismo objeto.

## Catálogo

### `validacion` — los datos no sirven

Falta el nombre del cliente, no hay líneas, el tipo de documento no existe.
Repetirlo da lo mismo. El documento **no** se creó.

### `auth` — la API key

Falta, está mal copiada, venció o la revocaron. Se regenera en Egestia →
Integraciones. Las claves empiezan con `egst_`.

### `scope` — permisos de la key

A la clave le falta el permiso de esa operación. Para emitir, anular y consultar
boletas y facturas hace falta `documents`; para las boletas de honorarios de
terceros, `honorarios`; para el catálogo, `read`; para stock y productos,
`write`. Una clave con `write` puede todo.

### `configuracion` — falta algo en Egestia

El cliente no terminó de configurarse. Los casos que reconoce:

| Mensaje | Qué falta |
|---|---|
| Configure la empresa SII primero | Los datos del emisor, en SII → Configuración |
| El ambiente SII no está habilitado | Activar «Ambiente habilitado para emitir documentos» |
| Certificado… | El certificado digital falta o venció |
| …no tiene clave tributaria | La clave del SII, en Configuración → SII → Certificado Digital. Sin ella no hay boletas de honorarios |

**El documento queda creado en borrador.** Cuando se resuelva la configuración,
reenviar la venta lo emite —con su folio.

### `sin_folios` — se acabó el CAF

El más común en producción, y el que detiene la facturación entera.

```
tipo ........ sin_folios
mensaje ..... No hay folios disponibles para este tipo de documento
qué hacer ... Pedir un CAF nuevo al SII y cargarlo en Egestia (SII → Folios/CAF).
documento ... 4f94eb3e…      ← la venta NO se perdió
```

**La venta no se pierde.** El documento queda en borrador y el siguiente reenvío
lo emite con el primer folio del CAF nuevo.

Para no llegar nunca a esto:

```ts
const { tipos } = await egestia.folios();
for (const t of tipos) {
  if (t.disponibles < 50) avisar(`Quedan ${t.disponibles} folios del DTE ${t.dteCode}`);
}
```

### `sii` — el SII rechazó o no contestó

El documento llegó al SII y volvió con reparos o rechazado. El detalle está en
`problema.sii`, tal como lo devolvió el organismo. Hay que corregir antes de
reemitir; como el documento queda en `rejected`, reenviar la venta conserva el
folio.

### `ya_aceptado` — se intentó corregir algo aceptado

No viene del servidor: lo detecta el SDK comparando el contenido del envío con
el anterior. Ver [estados](estados.md).

La salida es `anularYReemitir()`.

### `no_encontrado` — el id no existe para esa clave

Casi siempre es el id equivocado, o una clave de **otro** cliente: cada empresa
vive en su propio esquema y sus documentos no se ven desde fuera.

### `red` — no hubo respuesta

No llegó, o no alcanzó a contestar. **No se sabe si la venta se facturó.**

Es el único tipo con `reintentable: true`, pero el `queHacer` insiste en el
orden correcto: preguntar antes de reintentar.

```ts
const existente = await egestia.documentos.buscarPorReferencia(pedido.id);
if (!existente) await egestia.documentos.emitir(venta);
```

### `servidor` — Egestia falló

Un 5xx que no es de emisión. Se puede reintentar en unos segundos; el SDK ya lo
hizo un par de veces antes de rendirse.

## El caso que hay que entender bien

Cuando `problema.documentId` viene con valor, **la venta ya está registrada en
Egestia**. Da igual que la respuesta haya sido un error.

Qué hacer:

```ts
if (r.problema.documentId) {
  // guardar el id y resolver la causa (folios, certificado, lo que sea)
  await guardarPendiente(r.problema.documentId);
}
```

Qué **no** hacer: emitir de nuevo con otra referencia «para que salga limpio».
Eso crea un segundo documento y gasta un segundo folio por la misma venta.

Reenviar la MISMA venta, en cambio, es siempre seguro: reutiliza el documento y
su folio. Es de lo que trata [reintentos y folios](reintentos-y-folios.md).
