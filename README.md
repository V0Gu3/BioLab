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

### Supabase

1. Crea un proyecto PostgreSQL en Supabase y espera a que termine de aprovisionarse.
2. En **Connect**, copia la URI de conexión del pooler para aplicaciones serverless.
3. Pégala en `DATABASE_URL` dentro de tu archivo `.env`. Ese archivo no se sube a Git.
4. Inicia `npm start`; PROBIOLAB crea sus tablas automáticamente en la primera conexión.

Para comprobar la estructura, relaciones esenciales e índices sin modificar datos operativos, ejecuta `npm run db:check`.

En una base nueva, crea el primer administrador agregando temporalmente `BIO_INITIAL_ADMIN_EMAIL` y `BIO_INITIAL_ADMIN_PASSWORD` a `.env` y ejecutando `npm run db:bootstrap-admin`. Elimina de inmediato la línea de contraseña; la cuenta ya quedará creada en Supabase para iniciar sesión desde Vercel.

En Vercel se usa la misma URI como variable de entorno `DATABASE_URL` para Production, Preview y Development. No se deben usar las claves públicas, la `service_role` ni las claves de API de Supabase en este proyecto.

Si Docker está disponible, `docker-compose.postgres.yml` contiene una instancia preparada para desarrollo. También puedes utilizar PostgreSQL instalado o un servicio administrado.

La base SQLite anterior se conserva únicamente como origen de migración. Con PostgreSQL disponible ejecuta `npm run migrate:sqlite` una sola vez y valida el resumen antes de retirar el respaldo.

## Comandos

- `npm start`: inicia interfaz y API.
- `npm run dev`: inicia el servidor con recarga por cambios.
- `npm test`: ejecuta todas las pruebas.
- `npm run migrate:sqlite`: transfiere el snapshot de `data/bio.db` a PostgreSQL.

Consulta [docs/persistencia.md](docs/persistencia.md) para conocer el modelo y la API.
