/**
 * El registro de interacciones.
 *
 * Una interacción es UN ENVÍO de venta, no una venta: si el cliente manda,
 * falla por un dato malo, lo corrige y vuelve a mandar, eso es la MISMA
 * interacción con datos distintos. Egestia lo reconoce por su identificador y
 * corrige el documento que ya existe, reutilizando su folio, en vez de quemar
 * otro del CAF.
 *
 * Quien pone ese identificador es el SDK. Pedírselo a quien integra sería
 * trasladarle un problema que no le corresponde —y bastaría que se le olvide
 * una vez para duplicar un DTE—.
 */

export interface Interaccion {
  /** El identificador que viaja a Egestia. */
  id: string;
  /** Con qué se reconoce el envío desde afuera: la referencia de la venta. */
  clave: string;
  intentos: number;
  creada: string;
  ultimoIntento: string;
  /** Id del documento en Egestia, una vez que existe. */
  documentId?: string | null;
  folio?: string | null;
  estado?: string | null;
  ultimoProblema?: string | null;
  /** Huella del último envío: distingue un reenvío igual de una corrección. */
  huella?: string | null;
}

/**
 * Dónde se guardan las interacciones.
 *
 * Por defecto, en memoria: alcanza para un proceso que reintenta su propia
 * cola. Si los reintentos pueden ocurrir en OTRO proceso —una cola distribuida,
 * un servidor que se reinicia—, hay que enchufar algo que persista: Redis, una
 * tabla, un archivo. La interfaz es a propósito de dos métodos.
 */
export interface AlmacenInteracciones {
  leer(clave: string): Promise<Interaccion | null> | Interaccion | null;
  guardar(clave: string, interaccion: Interaccion): Promise<void> | void;
}

/** Almacén en memoria. Se pierde al reiniciar: para eso está el enchufe. */
export class AlmacenEnMemoria implements AlmacenInteracciones {
  private readonly mapa = new Map<string, Interaccion>();

  leer(clave: string): Interaccion | null {
    return this.mapa.get(clave) ?? null;
  }

  guardar(clave: string, interaccion: Interaccion): void {
    this.mapa.set(clave, interaccion);
  }

  /** Todo lo registrado, para inspeccionarlo o volcarlo a otro lado. */
  todas(): Interaccion[] {
    return [...this.mapa.values()];
  }
}

/** Identificador propio, sin dependencias. */
const nuevoId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `int_${uuid.replace(/-/g, '').slice(0, 24)}`;
  return `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};

export class RegistroInteracciones {
  constructor(private readonly almacen: AlmacenInteracciones) {}

  /**
   * La interacción de esta venta: la que ya había, o una nueva.
   *
   * Cada vez que se pide, se cuenta un intento más. Así el número de intentos
   * es real y no depende de que alguien se acuerde de incrementarlo.
   */
  async abrir(clave: string): Promise<Interaccion> {
    const ahora = new Date().toISOString();
    const previa = await this.almacen.leer(clave);

    const interaccion: Interaccion = previa
      ? { ...previa, intentos: previa.intentos + 1, ultimoIntento: ahora }
      : { id: nuevoId(), clave, intentos: 1, creada: ahora, ultimoIntento: ahora };

    await this.almacen.guardar(clave, interaccion);
    return interaccion;
  }

  /** Anota cómo terminó el intento. */
  async cerrar(clave: string, datos: Partial<Interaccion>): Promise<void> {
    const actual = await this.almacen.leer(clave);
    if (!actual) return;
    await this.almacen.guardar(clave, { ...actual, ...datos });
  }

  ver(clave: string): Promise<Interaccion | null> | Interaccion | null {
    return this.almacen.leer(clave);
  }
}
