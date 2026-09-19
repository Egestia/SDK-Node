import { HttpCliente } from './http.js';
import { EgestiaError } from './errors.js';
import { explicar, type Resultado } from './diagnostico.js';
import { AlmacenEnMemoria, RegistroInteracciones } from './interacciones.js';
import type {
  Anulacion,
  AnularHonorario,
  BoletaHonorarios,
  Documento,
  DocumentoAnulado,
  DocumentoEmitido,
  EmitirDocumento,
  EmitirFacturaCompra,
  EmitirHonorario,
  FacturaCompra,
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
  readonly honorarios: Honorarios;
  readonly facturasCompra: FacturasCompra;
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
    this.honorarios = new Honorarios(this.http, this.interacciones);
    this.facturasCompra = new FacturasCompra(this.http, this.interacciones);
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

/**
 * Boletas de honorarios de terceros (BHTE).
 *
 * La empresa emite la boleta POR CUENTA del prestador: le retiene al SII lo que
 * corresponde y le transfiere el resto. Es otro registro del SII —una boleta de
 * honorarios no es un DTE— y no gasta folios del CAF.
 *
 * ```ts
 * const boleta = await egestia.honorarios.emitir({
 *   rut: '11.111.111-1',
 *   nombre: 'Ana Soto',
 *   bruto: 1_000_000,            // lo que se acordó pagar
 *   referencia: pago.id,         // ← lo que evita emitir dos veces
 *   descripcion: 'Diseño de marca',
 * });
 *
 * await transferir(boleta.issuer.rut, boleta.netAmount);   // ← el LÍQUIDO
 * ```
 *
 * Lo que se transfiere es `netAmount` y no `grossAmount`: la diferencia
 * —`withheldAmount`— la entera la empresa al SII, y transferirla igual
 * significa pagarla dos veces.
 */
class Honorarios {
  constructor(
    private readonly http: HttpCliente,
    private readonly interacciones: RegistroInteracciones,
  ) {}

  /**
   * Emite una boleta de honorarios de terceros.
   *
   * Se manda el BRUTO y nada más: la retención la aplica el SII con la tasa
   * vigente para ese receptor —cambia todos los años— y vuelve en la respuesta,
   * junto con el líquido que hay que transferir.
   *
   * **Manda siempre `referencia`.** Acá pesa más que en una venta: un DTE de
   * más es un folio quemado, pero una boleta de más es una retención que la
   * empresa declara y entera al SII, y un prestador con dos boletas a su
   * nombre. Deshacerlo es anular en el SII, con causa, y rehacer el pago.
   *
   * Con referencia, repetir la llamada devuelve la boleta que ya existe
   * (`repetido: true`) en vez de emitir otra, y el SDK puede reintentar solo
   * ante un corte de red. Sin ella no reintenta, porque un segundo intento
   * significaría una segunda boleta.
   */
  async emitir(datos: EmitirHonorario): Promise<BoletaHonorarios> {
    if (!datos?.rut) throw new Error('Se requiere el RUT del prestador');
    if (!(datos.bruto > 0)) {
      throw new Error(
        'Se requiere `bruto`: el monto acordado con el prestador. El líquido a transferir lo ' +
        'devuelve esta misma llamada, ya con la retención del SII descontada.',
      );
    }

    // El registro sirve para saber cuántas veces se ha reintentado este pago.
    // La clave lleva su prefijo: un pago y una venta pueden compartir número en
    // el sistema de origen sin ser lo mismo.
    const origen = datos.origen ?? 'sdk';
    const clave = datos.referencia ? `honorarios:${origen}:${datos.referencia}` : null;
    if (clave) await this.interacciones.abrir(clave);

    try {
      const boleta = await this.http.pedir<BoletaHonorarios>({
        method: 'POST',
        path: '/honorarios',
        // Con referencia, repetir es seguro: Egestia devuelve la boleta que ya
        // emitió. Sin ella, un reintento emitiría una segunda ante el SII.
        repetible: Boolean(datos.referencia),
        body: {
          rut: datos.rut,
          name: datos.nombre,
          grossAmount: datos.bruto,
          issueDate: datos.fecha,
          description: datos.descripcion,
          reference: datos.referencia ?? null,
          source: origen,
          branchId: datos.sucursal ?? null,
          direccion: datos.direccion,
          comuna: datos.comuna,
          codigoRegion: datos.codigoRegion,
        },
      });

      if (clave) {
        await this.interacciones.cerrar(clave, {
          documentId: boleta.id, folio: boleta.folio, estado: boleta.status, ultimoProblema: null,
        });
      }
      return boleta;
    } catch (error) {
      if (clave) {
        const p = explicar(error);
        await this.interacciones.cerrar(clave, { ultimoProblema: p.mensaje });
      }
      throw error;
    }
  }

  /** `emitir` sin lanzar: devuelve el problema explicado. */
  async intentarEmitir(datos: EmitirHonorario): Promise<Resultado<BoletaHonorarios>> {
    try {
      return { ok: true, datos: await this.emitir(datos) };
    } catch (error) {
      return { ok: false, problema: explicar(error) };
    }
  }

  /** La boleta: folio, montos, estado en el SII. */
  obtener(id: string): Promise<BoletaHonorarios> {
    return this.http.pedir<BoletaHonorarios>({
      method: 'GET', path: `/honorarios/${id}`, repetible: true,
    });
  }

  /**
   * Busca la boleta de un pago por su referencia.
   *
   * Es la manera segura de recuperarse de un corte: antes de reintentar, se
   * pregunta si ese pago ya emitió boleta. Devuelve `null` si todavía no.
   */
  buscarPorReferencia(referencia: string, opts: { origen?: string } = {}): Promise<BoletaHonorarios | null> {
    return this.http.pedir<BoletaHonorarios | null>({
      method: 'GET',
      path: '/honorarios',
      repetible: true,
      query: { reference: referencia, source: opts.origen },
    });
  }

  /**
   * Anula en el SII una boleta que emitió la empresa.
   *
   * La causa la exige el SII y ofrece exactamente dos: `no_prestacion` —el
   * servicio no se prestó— o `error_digitacion` —se emitió con un dato malo—.
   * La anulación queda declarada y el prestador puede reclamarla.
   *
   * Es idempotente: si ya estaba anulada devuelve esa misma (`repetido: true`).
   *
   * Anular NO devuelve la plata: si ya se transfirió el líquido, eso se
   * resuelve aparte.
   */
  // `async` a propósito, aunque valide antes de salir a la red: así el error de
  // la causa que falta llega por el mismo camino que los demás —un `.catch()` o
  // un `intentarAnular()`— y no como una excepción suelta que se escapa de la
  // cola que lo llamó.
  async anular(id: string, opts: AnularHonorario): Promise<BoletaHonorarios> {
    if (!opts?.causa) {
      throw new Error('El SII exige una causa: «no_prestacion» o «error_digitacion»');
    }
    return this.http.pedir<BoletaHonorarios>({
      method: 'POST',
      path: `/honorarios/${id}/anular`,
      // Idempotente del lado del servidor: reintentar no anula «más».
      repetible: true,
      body: { causa: opts.causa },
    });
  }

  /** `anular` sin lanzar: devuelve el problema explicado. */
  async intentarAnular(id: string, opts: AnularHonorario): Promise<Resultado<BoletaHonorarios>> {
    try {
      return { ok: true, datos: await this.anular(id, opts) };
    } catch (error) {
      return { ok: false, problema: explicar(error) };
    }
  }
}

/**
 * Facturas de compra por servicios del exterior (DTE 46).
 *
 * Cuando le pagas a un prestador de otro país —un creador, un freelancer, un
 * servicio— y tu empresa es contribuyente de IVA en Chile, la ley te convierte
 * en el sujeto del impuesto (DL 825 art. 11 letra e): el SII te exige emitir TÚ
 * la factura, recargar el IVA y retenerlo entero (Res. Ex. 42/2018).
 *
 * ```ts
 * const factura = await egestia.facturasCompra.emitir({
 *   nombre: creador.nombre,
 *   pais: creador.pais,
 *   monto: 1000,                  // el NETO, en la moneda del pago
 *   moneda: 'USD',
 *   referencia: pago.id,          // ← lo que evita emitir dos veces
 *   descripcion: 'Contenido de septiembre',
 * });
 *
 * await transferir(creador, factura.amount);   // lo pactado, en su moneda
 * ```
 *
 * Mandas el NETO y nada más: el IVA lo calcula Egestia con el tipo de cambio
 * del día, lo recarga y lo retiene entero, así que el total del documento vuelve
 * a ser el neto. En pesos eso es `net`; en la moneda del pago, `amount`. El IVA
 * retenido (`withheld`) lo declaras en el código 39 del F29, y el mismo IVA es
 * tu crédito fiscal.
 *
 * No hay `anular`: un DTE 46 emitido se echa atrás con una nota de crédito, y
 * eso hoy se hace desde Egestia.
 */
class FacturasCompra {
  constructor(
    private readonly http: HttpCliente,
    private readonly interacciones: RegistroInteracciones,
  ) {}

  /**
   * Emite la factura de compra por un pago al exterior.
   *
   * **Manda siempre `referencia`.** Acá pesa más que en una venta: un DTE 46
   * duplicado son tres cosas mal —el folio quemado, una cuenta por pagar de más
   * al prestador, y un crédito fiscal duplicado en el F29—, y el camino de
   * vuelta es una nota de crédito que el SII y el prestador ven.
   *
   * Con referencia, repetir la llamada devuelve la factura que ya existe
   * (`repetido: true`) en vez de emitir otra. Y si un intento anterior quedó a
   * medias —sin CAF, sin tipo de cambio— el reintento retoma ESE borrador y lo
   * emite con su mismo folio, en vez de dejar uno nuevo cada vez.
   */
  async emitir(datos: EmitirFacturaCompra): Promise<FacturaCompra> {
    if (!datos?.nombre) throw new Error('Se requiere el nombre del prestador');
    const tieneDetalle = Array.isArray(datos.items) && datos.items.length > 0;
    if (!tieneDetalle && !(datos.monto! > 0)) {
      throw new Error(
        'Se requiere `monto` —lo acordado con el prestador, en su moneda— o `items` con el detalle. ' +
        'Va el NETO: el IVA lo recarga y lo retiene Egestia.',
      );
    }

    const origen = datos.origen ?? 'sdk';
    const clave = datos.referencia ? `facturas-compra:${origen}:${datos.referencia}` : null;
    if (clave) await this.interacciones.abrir(clave);

    try {
      const factura = await this.http.pedir<FacturaCompra>({
        method: 'POST',
        path: '/facturas-compra',
        // Con referencia, repetir es seguro: Egestia devuelve la que ya emitió,
        // o retoma el borrador que quedó. Sin ella, otro DTE 46.
        repetible: Boolean(datos.referencia),
        body: {
          rut: datos.rut,
          name: datos.nombre,
          country: datos.pais,
          address: datos.direccion,
          giro: datos.giro,
          amount: datos.monto,
          items: datos.items?.map((l) => ({
            description: l.descripcion,
            quantity: l.cantidad,
            unitPrice: l.precioUnitario,
            amount: l.monto,
          })),
          description: datos.descripcion,
          currency: datos.moneda ?? 'USD',
          exchangeRate: datos.tipoCambio ?? null,
          issueDate: datos.fecha,
          invoiceNumber: datos.numeroInvoice,
          reference: datos.referencia ?? null,
          source: origen,
          expenseAccountId: datos.cuentaGastoId ?? null,
          notes: datos.notas ?? null,
          emit: datos.emitir ?? true,
        },
      });

      if (clave) {
        await this.interacciones.cerrar(clave, {
          documentId: factura.id, folio: factura.folio, estado: factura.status, ultimoProblema: null,
        });
      }
      return factura;
    } catch (error) {
      // El fallo se anota: la factura pudo quedar en borrador, y el próximo
      // intento tiene que encontrarla por su referencia.
      if (clave) {
        const p = explicar(error);
        await this.interacciones.cerrar(clave, {
          documentId: p.documentId ?? null, ultimoProblema: p.mensaje,
        });
      }
      throw error;
    }
  }

  /** `emitir` sin lanzar: devuelve el problema explicado. */
  async intentarEmitir(datos: EmitirFacturaCompra): Promise<Resultado<FacturaCompra>> {
    try {
      return { ok: true, datos: await this.emitir(datos) };
    } catch (error) {
      return { ok: false, problema: explicar(error) };
    }
  }

  /** La factura: folio, montos, estado en el SII. */
  obtener(id: string): Promise<FacturaCompra> {
    return this.http.pedir<FacturaCompra>({
      method: 'GET', path: `/facturas-compra/${id}`, repetible: true,
    });
  }

  /**
   * Busca la factura de un pago por su referencia.
   *
   * La manera segura de recuperarse de un corte: antes de reintentar, se
   * pregunta si ese pago ya emitió factura. Devuelve `null` si todavía no.
   */
  buscarPorReferencia(referencia: string, opts: { origen?: string } = {}): Promise<FacturaCompra | null> {
    return this.http.pedir<FacturaCompra | null>({
      method: 'GET',
      path: '/facturas-compra',
      repetible: true,
      query: { reference: referencia, source: opts.origen },
    });
  }

  /**
   * Le pregunta al SII en qué quedó la factura y actualiza su estado.
   *
   * El SII acepta el envío y resuelve después: una factura recién emitida queda
   * `enviada` hasta que contesta. En la app de Egestia esto es un botón.
   */
  verificar(id: string): Promise<FacturaCompra> {
    return this.http.pedir<FacturaCompra>({
      method: 'POST', path: `/facturas-compra/${id}/verificar`, repetible: true,
    });
  }

  /**
   * Emite y espera a que el SII se pronuncie.
   *
   * Emite y va preguntando hasta que la factura deje de estar `enviada`.
   */
  async emitirYEsperar(
    datos: EmitirFacturaCompra,
    opts: { intentos?: number; esperaMs?: number } = {},
  ): Promise<FacturaCompra> {
    const emitida = await this.emitir(datos);
    if (emitida.status !== 'enviada') return emitida;

    const intentos = opts.intentos ?? 8;
    const espera = opts.esperaMs ?? 3000;

    let factura = emitida;
    for (let i = 0; i < intentos && factura.status === 'enviada'; i += 1) {
      await new Promise((r) => setTimeout(r, espera));
      try {
        factura = await this.verificar(factura.id);
      } catch {
        // Que la consulta falle no invalida la emisión: el documento está en el
        // SII y su estado se puede mirar después.
        return factura;
      }
    }
    return factura;
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
