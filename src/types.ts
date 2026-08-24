/** Lo que Egestia puede emitir a través de la API pública. */
export type TipoDocumento = 'boleta' | 'boleta_exenta' | 'factura' | 'factura_exenta';

/** Estado del documento dentro de Egestia y frente al SII. */
export type EstadoDocumento = 'draft' | 'sent_to_sii' | 'accepted' | 'rejected' | 'reparo';

/**
 * El comprador, tal como lo conoce la web.
 *
 * Si no existe en Egestia se crea; si ya existe se reutiliza y se le completa
 * lo que le falte, sin pisar lo que el ERP ya tenía. La búsqueda es por RUT, y
 * si no hay RUT, por correo.
 */
export interface Cliente {
  name: string;
  /** Sin RUT se emite a consumidor final, que es lo normal en una boleta. */
  rut?: string;
  email?: string;
  phone?: string;
  /** Dirección, ciudad y giro: los imprime la FACTURA. */
  address?: string;
  city?: string;
  comuna?: string;
  giro?: string;
}

export interface LineaDocumento {
  /** Precio unitario NETO, en pesos. Egestia calcula el IVA. */
  unitPrice: number;
  /** Nombre de la línea tal como saldrá impreso. */
  name?: string;
  description?: string;
  quantity?: number;
  /** Descuento de la línea, en porcentaje. */
  discount?: number;
  /**
   * Código del producto en TU sistema.
   *
   * Es la forma de que el catálogo de Egestia se arme solo: la primera venta de
   * un SKU crea el producto, y de ahí en adelante todas las ventas de ese SKU
   * usan el mismo. Sin SKU la línea entra como texto suelto y no se puede saber
   * después cuánto se vendió de qué.
   */
  sku?: string;
  /** `true` si es un servicio: no descuenta stock. */
  isService?: boolean;
  unit?: string;
  /** 0.19 por defecto; 0 para exento. Sólo se usa al crear el producto. */
  taxRate?: number;
  /** Id del producto en Egestia, si se conoce. Manda sobre el SKU. */
  productId?: string;
}

export interface Pago {
  /** transferencia, webpay, mercadopago, efectivo… */
  method?: string;
  gateway?: string;
  amount?: number;
  paidAt?: string;
  /** Identificador del pago en la pasarela. */
  reference?: string;
}

export interface EmitirDocumento {
  tipo: TipoDocumento;
  cliente: Cliente;
  items: LineaDocumento[];
  /**
   * Identificador de ESTA venta en el sistema de origen.
   *
   * Es lo que hace la operación idempotente: si la petición se repite —un
   * reintento, un timeout, una cola que reenvía— Egestia devuelve el documento
   * que ya existe en vez de emitir otro. Sin referencia, un reintento quema un
   * folio del CAF por una venta que ya estaba facturada.
   */
  referencia?: string;
  /** De qué sistema viene la venta. Sirve para no confundir referencias. */
  origen?: string;
  /** Tienda o sucursal de origen: dos tiendas pueden repetir el mismo folio. */
  storeId?: number;
  /** Cómo se cobró. Si viene, el documento nace pagado y se emite al SII. */
  pago?: Pago | null;
  paymentMethod?: string;
  /** `false` deja el documento en borrador, sin tocar el SII. */
  emitir?: boolean;
  /**
   * Esperar a que el SII se pronuncie. Por defecto `true`.
   *
   * En la app de Egestia consultar el estado es un botón que alguien aprieta;
   * por SDK no hay nadie que apriete nada, así que el ciclo completo —emitir,
   * enviar, preguntar hasta tener respuesta— se hace solo.
   *
   * Ponlo en `false` si emites desde una cola y prefieres consultar después con
   * `documentos.sincronizar(id)`.
   */
  esperarSii?: boolean;
  /**
   * Normalmente NO se manda: lo pone el SDK.
   *
   * Sólo tiene sentido si tu proceso lleva su propio registro de reintentos y
   * quiere forzar la interacción de un envío anterior.
   */
  interactionId?: string;
}

export interface DocumentoEmitido {
  id: string;
  folio: string | null;
  type: TipoDocumento;
  total: number;
  status: EstadoDocumento;
  contactId: string;
  /** Identificador de envío del SII, para seguir el trámite. */
  trackId: string | null;
  /** Advertencia no fatal: el documento existe, pero algo quedó a medias. */
  aviso?: string | null;
  /** `true` cuando la referencia ya tenía documento: no se emitió otro. */
  repetido?: boolean;
  /** La interacción con la que quedó asociado el envío. */
  interactionId?: string | null;
  /** Cuántas veces se ha reenviado esta venta. */
  attempts?: number;
  /** `true` si este envío corrigió un documento que ya existía. */
  reintento?: boolean;
  /**
   * `false` cuando el SII ya lo recibió: no admite correcciones.
   *
   * En ese caso el camino es anular con nota de crédito y emitir uno nuevo.
   */
  corregible?: boolean;
  motivoNoCorregible?: string | null;
}

export interface FoliosPorTipo {
  /** Código DTE: 33 factura, 39 boleta, 61 nota de crédito… */
  dteCode: number;
  disponibles: number;
  desde: number | null;
  hasta: number | null;
  cafs: number;
}

export interface Folios {
  mode: 'certificacion' | 'produccion';
  tipos: FoliosPorTipo[];
}

export interface ItemDocumento {
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  total: number;
}

export interface Documento {
  id: string;
  type: TipoDocumento;
  dteCode: number | null;
  folio: string | null;
  status: EstadoDocumento;
  documentDate: string | null;
  subtotal: number;
  tax: number;
  exempt: number;
  total: number;
  currency: string;
  trackId: string | null;
  sentAt: string | null;
  notifiedAt: string | null;
  reference: string | null;
  source: string | null;
  contact: { id: string; name: string; rut: string; email: string | null } | null;
  items: ItemDocumento[];
}

export interface Anulacion {
  /** Por qué se anula. Sale impreso en la nota de crédito. */
  motivo?: string;
  /** `false` deja la nota de crédito en borrador, sin enviarla al SII. */
  emitir?: boolean;
}

export interface DocumentoAnulado extends Documento {
  /** Id del documento que esta nota de crédito anula. */
  anulaId: string;
  /** `true` si ya estaba anulado: se devuelve la nota que existía. */
  repetido?: boolean;
  aviso?: string | null;
}

export interface Producto {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  type: 'product' | 'service';
  /** Precio de venta vigente, ya con lista de precios aplicada. */
  price: number;
  /** Precio base del catálogo, antes de listas. */
  basePrice: number;
  taxRate: number;
  unit: string | null;
  barCode: string | null;
  brand: string | null;
  stockControl: boolean;
  isActive: boolean;
  stock?: number;
}

export interface PaginaProductos {
  data: Producto[];
  total: number;
  page: number;
  limit: number;
}

export interface OpcionesCliente {
  /**
   * Dónde guardar el registro de interacciones.
   *
   * Por defecto en memoria, que basta si el proceso que reintenta es el mismo
   * que emitió. Si los reintentos ocurren en otro proceso —una cola, un
   * servidor que se reinicia— hay que enchufar algo que persista.
   */
  almacen?: import('./interacciones.js').AlmacenInteracciones;
  /** La clave `egst_...` que se genera en Egestia → Integraciones. */
  apiKey: string;
  /** Raíz de la API. Por defecto, la nube de Egestia. */
  baseUrl?: string;
  /** Milisegundos antes de abandonar una petición. Por defecto 30.000. */
  timeout?: number;
  /** Reintentos ante fallos de red o 5xx. Por defecto 2. */
  reintentos?: number;
  /** Se antepone al User-Agent, para reconocer quién llama. */
  appName?: string;
  /** Implementación de fetch, por si el entorno no la trae. */
  fetch?: typeof globalThis.fetch;
}
