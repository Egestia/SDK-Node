# La API por debajo

El SDK envuelve la API pública de Egestia. Esto sirve para depurar, o para
integrar desde un lenguaje que todavía no tiene SDK.

**Raíz:** `https://api.egestia.cl/api/pub/v1`
**Autenticación:** `x-api-key: egst_…` (también sirve `Authorization: Bearer`)
**Respuestas:** todo viene envuelto en `{ "data": … }`; los errores, en
`{ "error": "…" }`.

## Endpoints

| Método | Ruta | Scope | Para qué |
|---|---|---|---|
| POST | `/orders` | `documents` | Emitir boleta o factura |
| GET | `/documents/:id` | `documents` | Estado del documento |
| GET | `/documents?reference=` | `documents` | Buscar por la referencia de tu venta |
| POST | `/documents/:id/sync` | `documents` | Preguntarle al SII en qué quedó |
| POST | `/documents/:id/void` | `documents` | Anular con nota de crédito |
| GET | `/documents/:id/xml` | `documents` | El DTE firmado |
| GET | `/folios` | `documents` | Folios disponibles por tipo |
| POST | `/honorarios` | `honorarios` | Emitir boleta de honorarios de terceros |
| GET | `/honorarios?reference=` | `honorarios` | Buscar por la referencia de tu pago |
| GET | `/honorarios/:id` | `honorarios` | Estado y montos de la boleta |
| POST | `/honorarios/:id/anular` | `honorarios` | Anularla en el SII |
| GET | `/products` | `read` | El catálogo |
| POST | `/products/upsert` | `write` | Crear o actualizar por SKU |
| POST | `/stock/commit` | `write` | Descontar stock al cobrar |
| POST | `/stock/release` | `write` | Devolverlo si el pago se cae |

## POST /orders

```jsonc
{
  "type": "boleta",              // boleta | boleta_exenta | factura | factura_exenta
  "reference": "WEB-10045",      // tu número de venta
  "source": "mi-web",
  "storeId": null,               // si tienes varias tiendas
  "interactionId": "int_a1b2…",  // lo pone el SDK

  "contact": {
    "name": "Juan Pérez",
    "rut": "12.345.678-5",       // sin RUT → consumidor final
    "email": "juan@correo.cl",
    "address": "Los Aromos 442", // dirección, ciudad y giro los imprime la FACTURA
    "city": "Santiago",
    "giro": "Particular"
  },

  "items": [
    {
      "sku": "PLAN-BASICO",      // crea el producto la primera vez, lo reutiliza después
      "name": "Plan mensual",
      "unitPrice": 19900,        // NETO: Egestia calcula el IVA
      "quantity": 1,
      "discount": 0,
      "isService": true          // un servicio no descuenta stock
    }
  ],

  "payment": { "method": "webpay", "amount": 23681 },  // si viene, se emite al SII
  "emit": true
}
```

Respuesta:

```jsonc
{
  "data": {
    "id": "d41f…", "folio": "5001", "type": "boleta",
    "total": 23681, "status": "sent_to_sii", "trackId": "12334111550",
    "interactionId": "int_a1b2…", "attempts": 1,
    "reintento": false,
    "corregible": true         // false cuando el SII ya lo aceptó
  }
}
```

**El 502 que no es un fallo cualquiera** — el documento existe:

```jsonc
{
  "error": "Documento creado pero no emitido: No hay folios disponibles…",
  "data": {
    "id": "d41f…", "status": "draft",
    "motivo": "No hay folios disponibles para este tipo de documento",
    "sii": null,
    "interactionId": "int_a1b2…", "folioReservado": null
  }
}
```

## Qué hace Egestia con el pedido

```mermaid
flowchart TD
  A[POST /orders] --> B{¿hay documento<br/>para esta interacción<br/>o referencia?}
  B -->|no| C[cliente: por RUT, o por correo<br/>se crea si no existe]
  C --> D[productos: por SKU<br/>se crean sólo los nuevos]
  D --> E[documento + cálculo de IVA<br/>e impuestos adicionales]
  B -->|sí, borrador o rechazado| F[actualiza el existente<br/>conserva el folio]
  B -->|sí, aceptado| G[lo devuelve · corregible: false]
  E --> H{¿viene payment<br/>y emit?}
  F --> H
  H -->|no| I[queda en borrador]
  H -->|sí| J[folio del CAF · firma · envío al SII]
```

Sobre el cliente: si ya existe, se **completa** lo que le falte —típicamente la
dirección, que llega recién al comprar— sin pisar lo que el ERP ya tenía. El ERP
es la fuente de verdad; la web sólo aporta lo que él todavía no sabe.

## POST /documents/:id/void

```jsonc
{ "motivo": "Compra devuelta por el cliente", "emitir": true }
```

Emite la nota de crédito con `CodRef 1` —«anula el documento de referencia»—
copiando líneas y cliente del original. Idempotente: si ya estaba anulado
devuelve la nota existente con `repetido: true`.

## POST /honorarios

Boleta de honorarios de terceros (BHTE). Otro registro del SII: no es un DTE y
no gasta folios del CAF.

```jsonc
{
  "rut": "11.111.111-1",         // el PRESTADOR: quien hizo el trabajo
  "name": "Ana Soto",
  "grossAmount": 1000000,        // el BRUTO. La retención la aplica el SII
  "reference": "PAGO-77",        // tu número de pago
  "source": "pagos",
  "issueDate": "2026-09-17",     // por defecto, hoy
  "description": "Diseño de marca",
  "branchId": 3,                 // número de sucursal, o su UUID

  // Sólo para un prestador que todavía no es contacto en Egestia: normalmente
  // se toman de su ficha. El SII los imprime en la boleta y sin ellos rechaza.
  "direccion": "Los Aromos 442",
  "comuna": "Providencia"
}
```

Respuesta:

```jsonc
{
  "data": {
    "id": "8f2c…", "folio": "184", "status": "vigente", "kind": "emitida",
    "issuer": { "rut": "11111111-1", "name": "Ana Soto", "contactId": "c1…" },
    "issueDate": "2026-09-17", "period": "202609",
    "grossAmount":    1000000,   // lo que ganó el prestador
    "withholdingRate":   14.5,   // la tasa del SII, en PORCENTAJE
    "withheldAmount":  145000,   // lo entera la empresa al SII
    "netAmount":       855000,   // ← lo único que se transfiere
    "siiCode": "ABC123", "branchId": "a4f0…",
    "reference": "PAGO-77", "source": "pagos",
    "repetido": false
  }
}
```

`201` cuando se emitió; `200` con `repetido: true` cuando esa referencia ya
tenía boleta y no se emitió nada.

**El 409 que hay que mirar** — misma referencia, otro monto:

```jsonc
{
  "error": "La referencia «PAGO-77» ya emitió una boleta por $1000000, y ahora se pide por $500000…",
  "data": { "id": "8f2c…", "folio": "184", "netAmount": 855000, "repetido": true }
}
```

No es un reintento: es otro pago con la referencia equivocada. Devolver la
boleta vieja en silencio haría transferir el líquido de otra prestación.

El otro 409 es `Ya se está emitiendo la boleta de la referencia «…»`: hay una
llamada con esa misma referencia emitiendo en este instante. **No emitas otra**
—espera y consulta por referencia—. Es un candado de base de datos, y existe
porque el `GET` previo no alcanza a ver lo que todavía se está emitiendo: sin
él, dos llamadas simultáneas emiten dos boletas ante el SII.

## POST /honorarios/:id/anular

```jsonc
{ "causa": "error_digitacion" }   // o "no_prestacion". El SII no acepta otras.
```

A diferencia de un DTE, una boleta de honorarios se anula de verdad: no hay
nota de crédito de por medio. La anulación queda declarada y el prestador puede
reclamarla, por eso la causa es obligatoria.

Idempotente: si ya estaba anulada devuelve esa misma con `repetido: true`.
Anular **no** devuelve la plata ya transferida.

## GET /folios

```jsonc
{
  "data": {
    "mode": "produccion",
    "tipos": [
      { "dteCode": 39, "disponibles": 120, "desde": 8001, "hasta": 8120, "cafs": 1 }
    ]
  }
}
```

## La sucursal, cuando hay más de una tienda online

Las llamadas que miran o mueven stock aceptan `branchId`. Si no viene, Egestia
usa **la sucursal marcada como tienda online**.

Mientras haya una sola, no hay que mandar nada. Con dos o más, la llamada
responde **422** pidiendo la sucursal, porque adivinar de qué bodega descontar es
peor que preguntar: se vendería de un stock que no es.

```json
{ "error": "Hay más de una sucursal de tienda online: indica branchId." }
```

El mismo `branchId` es el que factura, así que los reportes por sucursal
muestran cada venta donde corresponde.

## Errores

| Código | Significa |
|---|---|
| 400 | Los datos no pasan la validación |
| 401 | API key inválida o expirada |
| 403 | Falta el scope |
| 404 | No existe para esa key |
| 409 | Conflicto de estado: ya emitido, sin folios, sin configurar |
| 502 | **Documento creado pero no emitido** — mira `data.id` |
