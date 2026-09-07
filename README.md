# PROBIOLAB

Sistema web para control comercial, compras, almacenes, documentos y trazabilidad.

## Iniciar el sistema

En Windows puedes ejecutar `INICIAR-PROBIOLAB.cmd`. También puedes iniciarlo desde una terminal:

```powershell
npm start
```

Después abre `http://127.0.0.1:8787`. La barra lateral debe indicar **Base central conectada**.

No abras `index.html` directamente para trabajo operativo: ese modo conserva compatibilidad local, pero no conecta con la base compartida.

## Base de datos

PROBIOLAB utiliza PostgreSQL. Copia `.env.example` como `.env` y configura `DATABASE_URL` con el usuario, contraseña, servidor y base de datos de PROBIOLAB.

Si Docker está disponible, `docker-compose.postgres.yml` contiene una instancia preparada para desarrollo. También puedes utilizar PostgreSQL instalado o un servicio administrado.

La base SQLite anterior se conserva únicamente como origen de migración. Con PostgreSQL disponible ejecuta `npm run migrate:sqlite` una sola vez y valida el resumen antes de retirar el respaldo.

## Comandos

- `npm start`: inicia interfaz y API.
- `npm run dev`: inicia el servidor con recarga por cambios.
- `npm test`: ejecuta todas las pruebas.
- `npm run migrate:sqlite`: transfiere el snapshot de `data/bio.db` a PostgreSQL.

Consulta [docs/persistencia.md](docs/persistencia.md) para conocer el modelo y la API.
