import { HttpCliente } from './http.js';
import { EgestiaError } from './errors.js';
import { explicar, type Resultado } from './diagnostico.js';
import { AlmacenEnMemoria, RegistroInteracciones } from './interacciones.js';
import type {
  Anulacion,
  Documento,
  DocumentoAnulado,
  DocumentoEmitido,
  EmitirDocumento,
  Folios,
  OpcionesCliente,
  PaginaProductos,
  Producto,
} from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './diagnostico.js';
export * from './interacciones.js';

const BASE_POR_DEFECTO = 'https://api.egestia.cl/api/pub/v1';

/**
 * Cliente de la API pública de Egestia.
 *
 * ```ts
 * const egestia = new Egestia({ apiKey: 'egst_...' });
 *
 * const doc = await egestia.documentos.emitir({
 *   tipo: 'boleta',
 *   referencia: pedido.id,          // ← lo que evita emitir dos veces
 *   cliente: { name: 'Juan Pérez', rut: '12.345.678-5', email: 'juan@correo.cl' },
 *   items: [{ sku: 'CONS-30', name: 'Consulta', unitPrice: 25000, quantity: 1 }],
 *   pago: { method: 'webpay', amount: 29750 },
 * });
 *
 * console.log(doc.folio, doc.status, doc.trackId);
 *
 * // Si hay que echar atrás la venta:
 * await egestia.documentos.anular(doc.id, { motivo: 'Compra devuelta' });
 * ```
 *
 * El cliente y los productos se crean solos la primera vez: el cliente se busca
 * por RUT (o por correo si no hay RUT) y el producto por SKU. La segunda venta
 * del mismo SKU reutiliza el producto que ya está en el catálogo.
 */
export class Egestia {
  private readonly http: HttpCliente;

  readonly documentos: Documentos;
  readonly productos: Productos;
  readonly stock: Stock;
  /** El registro de envíos, por si quieres inspeccionarlo o volcarlo. */
  readonly interacciones: RegistroInteracciones;

  /**
   * Cuántos folios quedan, por tipo de documento.
   *
   * Quedarse sin folios detiene la facturación entera y sólo se nota cuando una
   * venta falla. Con esto se puede avisar antes.
   */
  folios(mode?: 'certificacion' | 'produccion'): Promise<Folios> {
    return this.http.pedir<Folios>({
      method: 'GET', path: '/folios', repetible: true, query: { mode },
    });
  }

  constructor(opciones: OpcionesCliente) {
    if (!opciones?.apiKey) {
      throw new Error('Falta la API key. Se genera en Egestia → Integraciones y empieza con "egst_".');
    }

    this.http = new HttpCliente({
      apiKey: opciones.apiKey,
      baseUrl: opciones.baseUrl ?? BASE_POR_DEFECTO,
      timeout: opciones.timeout ?? 30000,
      reintentos: opciones.reintentos ?? 2,
      appName: opciones.appName,
      fetch: opciones.fetch,
    });

    this.interacciones = new RegistroInteracciones(opciones.almacen ?? new AlmacenEnMemoria());
    this.documentos = new Documentos(this.http, this.interacciones);
    this.productos = new Productos(this.http);
    this.stock = new Stock(this.http);
  }
}

/** Boletas y facturas: emitirlas y saber después cómo les fue. */
class Documentos {
  constructor(
    private readonly http: HttpCliente,
    private readonly interacciones: RegistroInteracciones,
  ) {}

  /**
   * Emite una boleta o factura.
   *
   * Con `pago` el documento nace pagado y se manda al SII; sin él queda en
   * borrador para que alguien lo revise en Egestia.
   *
   * **Manda siempre `referencia`**: es el número de la venta en TU sistema y es
   * lo único que impide emitir dos DTE por la misma venta si la petición se
   * repite. Con referencia, el SDK puede reintentar ante un corte de red sin
   * riesgo; sin ella no reintenta, porque un segundo intento significaría otro
   * folio del CAF quemado.
   */
  async emitir(datos: EmitirDocumento): Promise<DocumentoEmitido> {
    if (!datos?.items?.length) throw new Error('Se requiere al menos un ítem');
    if (!datos?.cliente?.name) throw new Error('Se requiere el nombre del cliente');

    // La interacción la abre el SDK, no quien integra.
    //
    // La clave es la referencia de la venta: mandar dos veces el mismo pedido
    // —aunque sea con los datos corregidos— reabre la MISMA interacción, y
    // Egestia corrige el documento que ya existe reutilizando su folio. Un
    // folio del CAF no se quema dos veces por una venta.
    const clave = datos.referencia ? `${datos.origen ?? 'sdk'}:${datos.referencia}` : null;
    const interaccion = clave ? await this.interacciones.abrir(clave) : null;
    const interactionId = datos.interactionId ?? interaccion?.id ?? null;

    // Huella del contenido: distingue un reenvío IGUAL —la cola que reintenta—
    // de una CORRECCIÓN, que es cuando alguien arregló un dato y volvió a
    // mandar. Importa porque un documento ya aceptado por el SII admite lo
    // primero (se devuelve tal cual) pero no lo segundo.
    const huella = huellaDe(datos);
    const huellaPrevia = interaccion?.huella ?? null;
    const esCorreccion = Boolean(huellaPrevia && huellaPrevia !== huella);

    try {
      const doc = await this.http.pedir<DocumentoEmitido>({
        method: 'POST',
        path: '/orders',
        // Con interacción, repetir es seguro: Egestia devuelve o corrige el
        // mismo documento. Sin ella, un reintento emitiría otro DTE.
        repetible: Boolean(interactionId),
        body: {
          type: datos.tipo,
          contact: datos.cliente,
          items: datos.items,
          reference: datos.referencia ?? null,
          source: datos.origen ?? 'sdk',
          storeId: datos.storeId ?? null,
          payment: datos.pago ?? null,
          paymentMethod: datos.paymentMethod ?? 'contado',
          emit: datos.emitir ?? true,
          interactionId,
        },
      });

      // Corregir algo que el SII ya recibió no se puede: el documento existe
      // en el mundo y en el libro de ventas. Se avisa con todas sus letras en
      // vez de dejar creer que la corrección se aplicó.
      if (doc.corregible === false && esCorreccion) {
        throw new EgestiaError(
          doc.motivoNoCorregible ||
            'El SII ya recibió este documento: no admite correcciones. Anúlalo y emite uno nuevo.',
          409,
          'ya_aceptado',
          { data: { ...doc } },
        );
      }

      // El SII no contesta al enviar: acepta el envío y resuelve después. En la
      // app de Egestia alguien aprieta un botón para preguntar; acá se hace
      // solo, que es lo que un SDK tiene que hacer por quien integra.
      let final = doc;
      if ((datos.esperarSii ?? true) && doc.status === 'sent_to_sii') {
        const resuelto = await this.esperarRespuestaSii(doc.id);
        if (resuelto) final = { ...doc, status: resuelto.status, folio: resuelto.folio ?? doc.folio };
      }

      if (clave) {
        await this.interacciones.cerrar(clave, {
          documentId: final.id, folio: final.folio, estado: final.status,
          ultimoProblema: null, huella,
        });
      }
      return { ...final, interactionId: final.interactionId ?? interactionId };
    } catch (error) {
      // El fallo también se anota: el documento pudo quedar creado, y el
      // próximo intento tiene que encontrarlo.
      if (clave) {
        const p = explicar(error);
        await this.interacciones.cerrar(clave, {
          documentId: p.documentId ?? null,
          estado: p.documentStatus ?? null,
          ultimoProblema: p.mensaje,
          huella,
        });
      }
      throw error;
    }
  }

  /**
   * Igual que `emitir`, pero devolviendo el problema en vez de lanzarlo.
   *
   * Un SDK puede explicar qué pasó, y eso es más útil que un `try/catch` con un
   * mensaje suelto: el resultado trae el tipo de problema, qué hacer, si
   * conviene reintentar y —lo que más importa— si el documento quedó creado
   * igual, con su id.
   *
   * ```ts
   * const r = await egestia.documentos.intentarEmitir(venta);
   * if (r.ok) {
   *   await guardarFolio(r.datos.folio);
   * } else {
   *   console.error(r.problema.mensaje);      // qué falló
   *   console.error(r.problema.queHacer);     // qué hacer al respecto
   *   if (r.problema.documentId) {
   *     // La venta YA está registrada: NO reemitir.
   *     await guardarPendiente(r.problema.documentId);
   *   }
   * }
   * ```
   */
  async intentarEmitir(datos: EmitirDocumento): Promise<Resultado<DocumentoEmitido>> {
    try {
      return { ok: true, datos: await this.emitir(datos) };
    } catch (error) {
      return { ok: false, problema: explicar(error) };
    }
  }

  /** `anular` sin lanzar: devuelve el problema explicado. */
  async intentarAnular(id: string, opts: Anulacion = {}): Promise<Resultado<DocumentoAnulado>> {
    try {
      return { ok: true, datos: await this.anular(id, opts) };
    } catch (error) {
      return { ok: false, problema: explicar(error) };
    }
  }

  /** Estado actual del documento: folio, si el SII lo aceptó, track id. */
  obtener(id: string): Promise<Documento> {
    return this.http.pedir<Documento>({ method: 'GET', path: `/documents/${id}`, repetible: true });
  }

  /**
   * Busca el documento de una venta por su referencia.
   *
   * Es la manera segura de recuperarse de un corte: antes de reintentar, se
   * pregunta si esa venta ya generó documento. Devuelve `null` si todavía no.
   */
  buscarPorReferencia(referencia: string, opts: { origen?: string; storeId?: number } = {}): Promise<Documento | null> {
    return this.http.pedir<Documento | null>({
      method: 'GET',
      path: '/documents',
      repetible: true,
      query: { reference: referencia, source: opts.origen, storeId: opts.storeId },
    });
  }

  /**
   * Anula un documento ya emitido.
   *
   * En Chile un DTE no se borra: se anula emitiendo una nota de crédito que lo
   * referencia. Eso hace este método, con las mismas líneas y el mismo cliente
   * del original.
   *
   * Se puede llamar dos veces sin miedo: si el documento ya estaba anulado
   * devuelve la nota que existía (`repetido: true`) en vez de emitir otra.
   */
  anular(id: string, opts: Anulacion = {}): Promise<DocumentoAnulado> {
    return this.http.pedir<DocumentoAnulado>({
      method: 'POST',
      path: `/documents/${id}/void`,
      // Idempotente del lado del servidor: reintentar no emite una segunda nota.
      repetible: true,
      body: { motivo: opts.motivo, emitir: opts.emitir },
    });
  }

  /**
   * Le pregunta al SII en qué quedó el documento y actualiza su estado.
   *
   * En la app de Egestia esto es un botón. Por SDK se hace solo dentro de
   * `emitir`, pero queda expuesto para las colas que emiten sin esperar.
   */
  sincronizar(id: string): Promise<Documento> {
    return this.http.pedir<Documento>({
      method: 'POST', path: `/documents/${id}/sync`, repetible: true,
    });
  }

  /** Pregunta hasta que el SII deje de decir «en camino». */
  private async esperarRespuestaSii(
    id: string,
    intentos = 8,
    esperaMs = 2500,
  ): Promise<Documento | null> {
    let doc: Documento | null = null;
    for (let i = 0; i < intentos; i += 1) {
      try {
        doc = await this.sincronizar(id);
      } catch {
        // Que la consulta falle no invalida la emisión: el documento está
        // enviado y su estado se puede mirar después.
        return doc;
      }
      if (doc.status !== 'sent_to_sii') return doc;
      await new Promise((r) => setTimeout(r, esperaMs));
    }
    return doc;
  }

  /**
   * El camino cuando el SII ya aceptó y hay que cambiar algo: anular y reemitir.
   *
   * Un DTE aceptado no se corrige. Esto anula el original con nota de crédito y
   * emite el documento nuevo con los datos correctos, en un solo paso.
   */
  async anularYReemitir(
    id: string,
    nuevo: EmitirDocumento,
    opts: Anulacion = {},
  ): Promise<{ anulado: DocumentoAnulado; emitido: DocumentoEmitido }> {
    const anulado = await this.anular(id, opts);
    // Referencia distinta a propósito: es una venta nueva para Egestia, y usar
    // la misma reabriría la interacción del documento que se acaba de anular.
    const emitido = await this.emitir({
      ...nuevo,
      referencia: nuevo.referencia ?? `${id}-r`,
    });
    return { anulado, emitido };
  }

  /** El XML firmado del DTE, para archivarlo donde corresponda. */
  xml(id: string): Promise<string> {
    return this.http.pedir<string>({
      method: 'GET', path: `/documents/${id}/xml`, repetible: true, crudo: true,
    });
  }

  /**
   * Emite y espera a que el SII se pronuncie.
   *
   * El SII no contesta al instante: acepta el envío y resuelve después. Esto
   * emite y va preguntando hasta que el documento deje de estar «en camino».
   */
  async emitirYEsperar(
    datos: EmitirDocumento,
    opts: { intentos?: number; esperaMs?: number } = {},
  ): Promise<Documento> {
    const emitido = await this.emitir(datos);
    const intentos = opts.intentos ?? 10;
    const espera = opts.esperaMs ?? 3000;

    let doc = await this.obtener(emitido.id);
    for (let i = 0; i < intentos && doc.status === 'sent_to_sii'; i += 1) {
      await new Promise((r) => setTimeout(r, espera));
      doc = await this.obtener(emitido.id);
    }
    return doc;
  }
}

/** El catálogo de Egestia, que es el que manda sobre precios y stock. */
class Productos {
  constructor(private readonly http: HttpCliente) {}

  /** El catálogo. Devuelve la lista directa; para el total usa `pagina()`. */
  async listar(opts: { page?: number; limit?: number; branchId?: string } = {}): Promise<Producto[]> {
    return (await this.pagina(opts)).data;
  }

  /** Igual que `listar`, pero con el total y la página, para recorrer todo. */
  pagina(opts: { page?: number; limit?: number; branchId?: string } = {}): Promise<PaginaProductos> {
    return this.http.pedir<PaginaProductos>({
      method: 'GET',
      path: '/products',
      repetible: true,
      query: { page: opts.page, limit: opts.limit, branchId: opts.branchId },
    });
  }

  obtener(id: string): Promise<Producto> {
    return this.http.pedir<Producto>({ method: 'GET', path: `/products/${id}`, repetible: true });
  }

  /** Crea o actualiza un producto por SKU. */
  guardar(producto: Partial<Producto> & { sku: string; name: string }): Promise<Producto> {
    return this.http.pedir<Producto>({
      method: 'POST', path: '/products/upsert', body: producto, repetible: true,
    });
  }
}

/**
 * Stock: Egestia lleva el libro mayor.
 *
 * Quien integra no escribe existencias: pide que se descuenten al cobrar
 * (`comprometer`) y que se devuelvan si el pago se cae (`liberar`).
 */
class Stock {
  constructor(private readonly http: HttpCliente) {}

  comprometer(datos: { reference: string; items: Array<{ sku: string; quantity: number }>; storeId?: number }) {
    return this.http.pedir({ method: 'POST', path: '/stock/commit', body: datos, repetible: true });
  }

  liberar(datos: { reference: string; storeId?: number }) {
    return this.http.pedir({ method: 'POST', path: '/stock/release', body: datos, repetible: true });
  }
}

/**
 * Huella del contenido de una venta.
 *
 * No pretende ser criptográfica: sólo tiene que cambiar cuando cambian los
 * datos que van al documento, para distinguir un reenvío idéntico de una
 * corrección.
 */
function huellaDe(datos: EmitirDocumento): string {
  const relevante = JSON.stringify({
    tipo: datos.tipo,
    cliente: datos.cliente,
    items: (datos.items ?? []).map((i) => [i.sku ?? i.name ?? i.description, i.quantity ?? 1, i.unitPrice, i.discount ?? 0]),
  });
  let h = 5381;
  for (let i = 0; i < relevante.length; i += 1) h = ((h * 33) ^ relevante.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export default Egestia;
