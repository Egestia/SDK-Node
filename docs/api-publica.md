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
