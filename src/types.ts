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

// ── Boletas de honorarios de terceros (BHTE) ─────────────────────────────────

/**
 * Las dos causas de anulación que acepta el SII. No hay más, y no hay «otra».
 *
 * `no_prestacion`: el servicio no se prestó.
 * `error_digitacion`: se emitió con un dato equivocado.
 */
export type CausaAnulacion = 'no_prestacion' | 'error_digitacion';

/** Estado de la boleta en el SII. Una anulada no se borra: queda marcada. */
export type EstadoBoleta = 'vigente' | 'anulada';

/**
 * Una boleta de honorarios que la empresa emite POR CUENTA del prestador.
 *
 * Se manda el BRUTO —lo que se acordó pagar por el trabajo— y nada más. La
 * retención no se calcula ni se manda: la aplica el SII con la tasa vigente
 * para ese receptor, que cambia todos los años, y vuelve en la respuesta.
 */
export interface EmitirHonorario {
  /** RUT del prestador: quien hizo el trabajo y cobra el líquido. */
  rut: string;
  /** Su nombre. Si ya es contacto en Egestia se completa solo. */
  nombre?: string;
  /**
   * El monto BRUTO, en pesos.
   *
   * Es lo que gana el prestador y lo que él declara como ingreso. Lo que se le
   * transfiere es menos: sale en `netAmount` de la respuesta.
   */
  bruto: number;
  /**
   * Identificador de ESTE pago en tu sistema. Mándalo siempre.
   *
   * Es lo que hace la operación idempotente. Sin referencia, un reintento
   * —una cola que reenvía, un timeout, un doble clic— emite una SEGUNDA boleta
   * ante el SII: otra retención que la empresa declara y entera, y un prestador
   * al que hay que explicarle por qué tiene dos.
   */
  referencia?: string;
  /** De qué sistema viene el pago. Dos sistemas pueden numerar igual. */
  origen?: string;
  /** Fecha de emisión, `AAAA-MM-DD`. Por defecto, hoy. */
  fecha?: string;
  /** Qué se prestó. Sale impreso en la boleta. */
  descripcion?: string;
  /**
   * Sucursal a la que se carga el gasto: su NÚMERO, el que sale en el listado
   * de sucursales, o su UUID. Sin ella la boleta queda sin centro de costo.
   */
  sucursal?: string | number;
  /**
   * Domicilio y comuna del prestador, que el SII imprime en la boleta.
   *
   * Normalmente no se mandan: se toman de su ficha de contacto en Egestia. Van
   * acá para el primer pago a alguien que todavía no es contacto.
   */
  direccion?: string;
  comuna?: string;
  codigoRegion?: number;
}

/**
 * Una boleta de honorarios, con los tres montos que el SII ya resolvió.
 *
 * Los tres van separados porque son tres cosas distintas, y deducir uno de otro
 * con una tasa que cambia cada año es exactamente el error que esto evita:
 *
 * ```
 * grossAmount     1.000.000   lo que ganó el prestador; lo que él declara
 * withheldAmount    145.000   lo retiene la empresa y lo entera al SII
 * netAmount         855.000   ← lo ÚNICO que se transfiere
 * ```
 */
export interface BoletaHonorarios {
  id: string;
  /** Número de la boleta en el SII. */
  folio: string | null;
  status: EstadoBoleta;
  /** `emitida` por la empresa, o `recibida` del prestador. */
  kind: 'emitida' | 'recibida';

  /** El prestador: a quien se le paga. */
  issuer: {
    rut: string;
    name: string | null;
    /** Su id de contacto en Egestia. */
    contactId: string | null;
  };

  issueDate: string | null;
  /** Período tributario `AAAAMM` al que corresponde. */
  period: string | null;
  description: string | null;

  /** Lo que ganó el prestador. Es lo que se manda al emitir. */
  grossAmount: number;
  /**
   * La tasa que aplicó el SII, en PORCENTAJE: `14.5` es 14,5 %.
   *
   * Viaja para mostrarla y cuadrarla, no para recalcular con ella. El número
   * bueno es `netAmount`, que ya viene aplicado.
   */
  withholdingRate: number | null;
  /** Lo que la empresa retiene y entera al SII. NO se transfiere. */
  withheldAmount: number;
  /** Lo único que se transfiere al prestador. */
  netAmount: number;

  /** Código con que el SII la identifica, para pedir su PDF. */
  siiCode: string | null;
  /** Sucursal a la que quedó cargado el gasto. */
  branchId: string | null;
  reference: string | null;
  source: string | null;

  /**
   * `true` cuando la llamada NO emitió nada: esa referencia ya tenía boleta y
   * se devolvió la que existía.
   */
  repetido?: boolean;
}

export interface AnularHonorario {
  /** La causa que exige el SII. Son dos, y hay que elegir una. */
  causa: CausaAnulacion;
}

// ── Facturas de compra por servicios del exterior (DTE 46) ───────────────────

/** Estado de la factura de compra en el SII. */
export type EstadoFacturaCompra = 'borrador' | 'enviada' | 'aceptada' | 'rechazada';

/** Una línea del servicio prestado, en la moneda en que se acordó. */
export interface LineaFacturaCompra {
  descripcion?: string;
  cantidad?: number;
  /** Precio unitario en la moneda del pago. */
  precioUnitario?: number;
  /** Monto de la línea. Sin él, se calcula como cantidad × precio. */
  monto?: number;
}

/**
 * Una factura de compra por un servicio prestado desde otro país.
 *
 * Cuando le pagas a un prestador del exterior —un creador, un freelancer, un
 * servicio— y tu empresa es contribuyente de IVA en Chile, la ley te convierte
 * en el sujeto del impuesto (DL 825 art. 11 letra e): el SII te exige emitir TÚ
 * la factura, recargar el IVA y retenerlo entero (Res. Ex. 42/2018).
 *
 * Se manda el NETO, o sea lo que acordaste pagarle. El IVA lo calcula y lo
 * retiene Egestia, y el total del documento vuelve a ser ese neto: es lo que se
 * le transfiere. El IVA retenido lo declaras en el código 39 del F29, y el
 * mismo IVA es tu crédito fiscal.
 */
export interface EmitirFacturaCompra {
  /** Nombre del prestador, tal como saldrá en la factura. */
  nombre: string;
  /**
   * Su número en la nómina de prestadores extranjeros inscritos del SII.
   *
   * Casi nunca lo vas a tener: un creador de otro país no tiene RUT chileno. Si
   * lo que mandas no tiene forma de RUT, Egestia resuelve el que corresponde
   * —el de la nómina si el nombre coincide con un inscrito conocido, o el
   * 55.555.555-5 que el SII indica para los no inscritos— y te lo dice en
   * `avisos`.
   */
  rut?: string;
  /** El país del prestador. Informativo, pero conviene guardarlo. */
  pais?: string;
  direccion?: string;
  giro?: string;

  /**
   * Lo acordado con el prestador, en su moneda. El NETO.
   *
   * Alternativa a `items`, y lo normal: un pago sin desglose. Egestia lo
   * convierte a pesos con el tipo de cambio del día de emisión.
   */
  monto?: number;
  /** El detalle, si el pago lo tiene. Manda sobre `monto`. */
  items?: LineaFacturaCompra[];
  /** Qué se prestó. Sale impreso en la factura. */
  descripcion?: string;

  /** `USD` por defecto. También `EUR` y `CLP`. */
  moneda?: 'USD' | 'EUR' | 'CLP';
  /**
   * Pesos por unidad de la moneda.
   *
   * Normalmente NO se manda: lo resuelve Egestia con el valor vigente a la
   * fecha de emisión, que es lo que exige el SII (Oficio 1794/2017). Mándalo
   * sólo para emitir una factura con fecha pasada y su tipo de cambio.
   */
  tipoCambio?: number;

  /** Fecha de emisión, `AAAA-MM-DD`. Por defecto, hoy en Chile. */
  fecha?: string;
  /** El número del invoice del prestador, si lo hay. Queda de respaldo. */
  numeroInvoice?: string;

  /**
   * Identificador de ESTE pago en tu sistema. Mándalo siempre.
   *
   * Es lo que hace la operación idempotente, y acá pesa más que en una venta:
   * un DTE 46 duplicado son tres cosas mal —el folio quemado, una cuenta por
   * pagar de más al prestador, y un crédito fiscal duplicado en el F29—. El
   * camino de vuelta es una nota de crédito que el SII y el prestador ven.
   */
  referencia?: string;
  /** De qué sistema viene el pago. Dos sistemas pueden numerar igual. */
  origen?: string;

  /** A qué cuenta de gasto va. Sin ella, la de gastos por omisión. */
  cuentaGastoId?: string;
  notas?: string;
  /** `false` deja la factura en borrador, sin tocar el SII. */
  emitir?: boolean;
}

/**
 * Una factura de compra, con los montos que resuelve el SII.
 *
 * ```
 * amount / currency   1000 USD   lo que acordaste pagarle
 * exchangeRate       980.5       con qué se convirtió, el día de emisión
 * net                980.500     el neto en pesos ← lo que se le transfiere
 * tax                186.295     el IVA que se recarga: tu crédito fiscal
 * withheld           186.295     el IVA retenido: código 39 del F29
 * total              980.500     el total del documento, que es el neto
 * ```
 */
export interface FacturaCompra {
  id: string;
  folio: string | null;
  status: EstadoFacturaCompra;
  /** Siempre 46: factura de compra electrónica. */
  dteCode: 46;

  /** El prestador: a quien se le paga. */
  supplier: {
    /** El que resolvió Egestia, que puede no ser el que mandaste. */
    rut: string | null;
    name: string | null;
    country: string | null;
    contactId: string | null;
  };

  issueDate: string | null;
  /** Período tributario `AAAAMM`. */
  period: string | null;

  /** La moneda en que se acordó el pago. */
  currency: string;
  /** Lo acordado, en esa moneda. */
  amount: number;
  /** Pesos por unidad de la moneda, el día de emisión. */
  exchangeRate: number | null;

  /** El neto en pesos. Es lo que se le transfiere al prestador. */
  net: number;
  /** El IVA recargado: crédito fiscal. */
  tax: number;
  /** El IVA retenido, que se declara en el código 39 del F29. Igual al `tax`. */
  withheld: number;
  /** El total del documento, que es el neto: neto + IVA − IVA retenido. */
  total: number;

  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    amountClp: number;
  }>;

  invoiceNumber: string | null;
  /** Identificador de envío del SII, para seguir el trámite. */
  trackId: string | null;
  reference: string | null;
  source: string | null;

  /**
   * Lo que conviene mirar: el RUT que se resolvió por nombre, un tipo de cambio
   * que no se pudo obtener. Que venga vacío es lo normal.
   */
  avisos: string[];

  /** `true` cuando la llamada NO emitió nada: esa referencia ya tenía factura. */
  repetido?: boolean;
}
