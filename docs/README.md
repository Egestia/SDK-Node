# Cómo funciona el SDK

Documentación de la mecánica interna. Para **usarlo**, el
[README del paquete](../README.md) alcanza y sobra; esto es para cuando algo no
salió como esperabas, o para saber por qué está hecho así.

## Los documentos

| | |
|---|---|
| [Arquitectura](arquitectura.md) | Las piezas, y qué pasa desde que llamas hasta que vuelve la respuesta |
| [Reintentos y folios](reintentos-y-folios.md) | La regla que ordena todo: un reintento no quema un folio nuevo |
| [Estados del documento](estados.md) | Qué se puede corregir, qué hay que anular, y por qué |
| [Problemas](problemas.md) | Catálogo de lo que puede fallar, con su causa y su salida |
| [La API por debajo](api-publica.md) | Los endpoints HTTP que el SDK envuelve |
| [Recetas](recetas.md) | Cómo se integra esto en una tienda de verdad |

## En una frase

Le mandas el JSON de una venta y te devuelve el documento tributario. El CAF, el
certificado y la conversación con el SII los maneja Egestia: tu sistema no
necesita saber nada de eso.

Y cuando a quien le pagas es un prestador y no un cliente, le mandas el bruto y
te devuelve la **boleta de honorarios** con la retención que aplicó el SII y el
líquido a transferir. Es otro registro del SII —no un DTE— y no gasta folios,
pero la regla es la misma y más cara: una boleta de más no es un folio quemado,
es una retención que la empresa declara y entera.

```
tu web  ──JSON──>  SDK  ──HTTPS──>  Egestia  ──DTE──>  SII
                    │                  │
                    │                  ├── folios (CAF)
                    │                  ├── certificado digital
                    │                  └── firma y envío
                    │
                    └── interacciones, reintentos, diagnóstico
```

## Lo que el SDK hace por ti

No es un envoltorio de `fetch`. Lo que aporta es exactamente lo que en una
integración de facturación sale caro cuando falta:

1. **Nunca emite dos veces la misma venta.** Cada envío abre una *interacción*
   que pone el SDK. Reenviar la misma venta reutiliza el documento y su folio.
2. **Reconoce una corrección de un reenvío idéntico.** Compara el contenido: si
   los datos cambiaron y el SII ya aceptó el documento, te frena.
3. **Cierra el ciclo con el SII solo.** Emite, envía y pregunta hasta tener
   veredicto. En la app de Egestia eso es un botón que alguien aprieta.
4. **Explica los problemas.** No devuelve «error 502», devuelve qué pasó, qué
   hacer, y si el documento quedó creado igual.

Cada una de esas cuatro tiene su documento arriba.
