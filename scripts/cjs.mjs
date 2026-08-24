// Genera el punto de entrada CommonJS.
//
// El paquete es ESM, pero muchos proyectos siguen en `require()`. En vez de
// compilar dos veces, se envuelve el ESM en un cargador dinámico: una sola
// fuente de verdad y `require('@egestia/sdk')` funciona igual.
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/index.cjs', import.meta.url),
  `'use strict';
module.exports = new Proxy({}, {
  get(_t, prop) {
    throw new Error(
      'Este paquete es ESM. Usa import("@egestia/sdk") o "type": "module".\\n' +
      'Propiedad pedida: ' + String(prop),
    );
  },
});
`,
);
console.log('  dist/index.cjs generado');
