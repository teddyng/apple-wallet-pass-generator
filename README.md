# Apple Wallet Pass Generator

A local web app for creating signed Apple Wallet `.pkpass` files.

## Free public hosting

Render is the simplest free backend option for this app because it can run the Node server and the OpenSSL/zip tools needed to create `.pkpass` files.

1. Push this folder to a GitHub repository.
2. Sign in to Render and choose **New > Web Service**.
3. Connect your GitHub repository.
4. Choose **Docker** for the runtime.
5. Choose the **Free** instance type.
6. Add an `ADMIN_PASSWORD` environment variable.
7. Let Render generate `SESSION_SECRET` from `render.yaml`, or set your own long random value.
8. For free persistent accounts, add `DATABASE_URL` from Neon Postgres.
9. Deploy.

Render will provide a public HTTPS URL after deployment. The included `Dockerfile` installs the native tools this app needs, and `render.yaml` sets the hosted server to listen correctly and health-check `/healthz`.

The default hosted username is `admin`. Set a strong `ADMIN_PASSWORD`; do not commit it to GitHub.

## Preflight checklist

- Copy `.env.example` for local configuration, but do not commit real `.env` files.
- Set `ADMIN_PASSWORD` in Render before deploying.
- Set a long random `SESSION_SECRET`, or let Render generate it from `render.yaml`.
- Never commit `.p12`, `.pem`, `.key`, `.cer`, `.crt`, `.der`, or Apple certificate files.
- Confirm the pass `passTypeIdentifier` exactly matches the Apple Pass Type ID certificate.
- Use persistent storage or a database before relying on hosted user accounts.
- For a free database, use Neon Postgres and set `DATABASE_URL`.
- Test login, account approval, password reset, and one generated pass before sharing the URL.

The app includes:

- Login-protected pass generation.
- Bulk pass creation from CSV rows.
- User account requests that require admin approval.
- User deletion from the admin page.
- Password reset requests that require admin approval.
- Login/account/password-reset rate limiting.
- Upload size/type checks for images and signing files.
- Admin-controlled stored P12/WWDR signing group.
- Image previews for uploaded pass artwork.
- Copy and paste supported pass JSON from the editor.
- Admin audit logging to `data/audit.log`.
- Admin metrics and login activity with IP addresses.
- A sticky footer with live app status.
- A live barcode preview in the pass editor.
- Light/dark mode.

Admin tools are available at `/admin` after signing in as an admin.

Account data is stored in Postgres when `DATABASE_URL` is set. Without `DATABASE_URL`, it falls back to `data/users.json`. On free hosted containers, local files may be reset when the service is rebuilt or redeployed.

Audit logs are stored in Postgres when `DATABASE_URL` is set, or `data/audit.log` locally. Logs contain account/admin action metadata only; they do not contain passwords or signing file contents.

## Stored signing group

Admins always have stored signing access. To let a normal user generate passes without uploading signing files, add them to the stored signing group from `/admin`.

Configure the stored certificate material outside GitHub:

```text
STORED_P12_BASE64=...
STORED_P12_PASSWORD=...
STORED_WWDR_BASE64=...
```

For local development, file paths also work:

```text
STORED_P12_PATH=/secure/path/certificate.p12
STORED_WWDR_PATH=/secure/path/wwdr.pem
```

Do not commit real certificate files or private keys.

## Free persistent storage with Neon

1. Create a free Neon Postgres project.
2. Copy the pooled connection string.
3. In Render, add:

```text
DATABASE_URL=postgresql://...sslmode=require
```

4. Redeploy the Render service.
5. Open `/healthz` on your Render URL.

You should see:

```json
{"ok":true,"storage":"postgres"}
```

If it says `"storage":"file"`, Render does not have `DATABASE_URL` set for this service.

## Run

```bash
./start-local.sh
```

Then open `http://localhost:4173`.

The local sign-in defaults are:

- Username: `admin`
- Password: `walletpass`

If that port is already busy:

```bash
PORT=4187 ./start-local.sh
```

## Required signing material

To install a generated pass on Apple Wallet, the pass must be signed with:

- A Pass Type ID certificate that matches the `passTypeIdentifier`.
- The matching private key, usually exported together as a `.p12`.
- The Apple Worldwide Developer Relations intermediate certificate.

The app sends these only to the local server process so it can create the detached signature inside the `.pkpass`.

For public hosting, do not keep certificate files in the repository. Upload signing files only through the form, and share the URL only with people you trust.
