# JereChess Online 2.4.5

Servidor de emparejamiento, partidas, resultados y reconexión para Cloudflare Workers + Durable Objects (SQLite).

**Estado:** preparación, no desplegado. No se deben activar las compilaciones ni fusionar esta rama con main antes de configurar el secreto TICKET_SECRET mediante Cloudflare y revisar las pruebas.

- Worker existente: jerechess-online.
- Firebase Project ID: jerechess-a4224.
- Directorio raíz de compilación en Cloudflare: /online-worker
- Comando de implementación: npx wrangler deploy
- CORS permitido: https://jerechess.com

El secreto TICKET_SECRET se define en la configuración de secretos del Worker, nunca se almacena en GitHub. El motor de ajedrez se usa como dependencia npm chess.js.

Las operaciones de emparejamiento y resultado aún requieren pruebas reales con dos cuentas y redes diferentes.
