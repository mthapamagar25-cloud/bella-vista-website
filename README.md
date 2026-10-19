# Bella Vista: your own booking system

This is a self-hosted booking application, with the Bella Vista website from the supplied archive and a new booking page and private dashboard. There is no booking-software subscription, per-booking commission or reservation-provider account required by this code. Version 1.1.1 uses the MySQL database supplied with your GoDaddy Node.js Hosting app. Normal domain and hosting costs still apply.

**Status:** v1.1.1 is built for the schema mismatch found in the hosted Preview. It still needs to be uploaded and checked there. The previous publish attempt rolled back because Publish did not have a valid ADMIN_PASSWORD. Set the live password and APP_ORIGIN separately before publishing. Customer booking requests start paused on a fresh installation; existing settings are retained.

## What you get

* `/`: the existing website, with booking buttons connected to the real booking page.
* `/book`: customers choose an available date, time and group size, and send a request without signing in.
* `/admin`: password-protected management on your phone, tablet or computer. Accept or decline requests, change their status, pause all bookings, close dates or arrival windows, and reopen them.
* `/booking-status`: each customer receives a private link to check their request or cancel it. The link's secret stays in the URL fragment and is sent only in a same-origin API request body, not in a URL query.
* Weekly opening hours, group-size limits, table duration, notice period and online seat capacity.
* CSV export and a JSON backup download. A backup includes booking contact information and must be kept private.

Customers are shown **Request received**, not **Confirmed**, until you accept. Pending requests reserve capacity, so review them regularly. Declining or cancelling releases that capacity. Closing dates stops new arrivals; it does not cancel existing bookings.

## Initial settings to review

| Setting | Initial value |
| --- | --- |
| New requests | Paused until you open them from the dashboard |
| First opening date | 3 November 2026 |
| Service days | Monday to Sunday |
| First arrival | 12:00 |
| Last arrival | 21:30 (proposed, editable) |
| Closing time | 23:30 |
| Table duration | 120 minutes (proposed, editable) |
| Total online seats | 52 |
| Largest online group | 12 (larger groups call) |
| Arrival interval | 30 minutes |
| Minimum notice | 60 minutes |
| Book ahead | 180 days |

The existing website says groups of 8 or more need a £10 deposit per guest. This remains visible. No payments are collected by this application. Staff must arrange and verify any deposit before accepting.

Capacity is a concurrent guest count, not a floor-plan allocator. Check whether the actual tables can accommodate the requested group before confirming. Reduce the online seat limit to leave room for walk-ins. This version has no staff entry form for phone bookings or walk-ins; close arrival windows or reduce online capacity to reserve space for them.

## GoDaddy setup

This version replaces the SQLite storage used in versions 1.0.0 and 1.0.1. It uses GoDaddy's managed MySQL directly. `DATA_DIR` is no longer used. There is no database file to put in Private Storage, and no manual SQL import is needed.

1. Keep a copy of the old website ZIP. If any earlier version has received real bookings, export/back up those records before replacing it. This version does not automatically import an earlier SQLite database.
2. Open your existing `bella-vista-website` app. Under **Settings > Hosted Database**, confirm the database is provisioned. The screenshot supplied for this app confirms that it is.
3. Configure these app secrets. Set them for Preview before testing, and for Publish before publishing. GoDaddy keeps the two sets separate.

| Name | Value |
| --- | --- |
| `ADMIN_PASSWORD` | Your own unique password, at least 14 characters. Keep the existing value if it meets that requirement. |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | The exact HTTPS origin used by that environment, with no path or trailing slash. For the live site: `https://bellavistalewisham.co.uk`. |

The Preview origin can differ from the published domain. Use the origin of the actual app page opened by Preview, not the GoDaddy dashboard's address. If a preview login says the request must come from the restaurant website, check this setting; do not disable the origin check. Do not copy a Preview origin over the live value during secret syncing.

GoDaddy supplies `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` automatically. The code reads all five from the environment. Do not replace these with invented values, copy them into website files, or send database passwords in chat. If runtime logs say a database variable is missing, consult **Hosted Database > Open database guide** for that app.

4. Upload the new ZIP to the existing app using **Update Preview**. The ZIP has `package.json` at its root and includes the lockfile and registry configuration. It excludes installed packages and credentials. GoDaddy installs the packages and runs the build/start commands.
5. Check Preview runtime logs. A successful start prints: `Bella Vista booking server v1.1.1 ready; hosted MySQL connected.`
6. Open the preview homepage, `/book` and `/admin`. Sign in and review the settings. Publish after the preview checks pass, ensuring Publish has its correct secrets, then restart Publish if GoDaddy requests it.

The app uses seven tables with names beginning `bv_`. New installations use `bv_reservations` for booking records. An existing compatible v1.1.0 `bv_bookings` table is reused so its reservations remain available. An incompatible empty legacy `bv_bookings` table, such as the older table with a `payload` column, is preserved unchanged while the app creates `bv_reservations`. Incompatible legacy records block startup until they are exported and migrated; the app does not silently discard them. It checks required column names before reporting ready. It does not drop or overwrite unrelated database tables. The database user needs permission to create these tables and read/write them. Settings are inserted only on the first run, so redeployment preserves existing settings.

**Preview and Publish share the same database.** A test booking, opening/closing change, or status change on Preview also affects Publish. Once the service is live, use a separate development database for further development. Capacity changes use an InnoDB transaction and a shared database lock, so simultaneous requests from multiple app instances cannot allocate the same remaining seats.

Required runtime: Node 22 or 24, MySQL with InnoDB, HTTPS, and the listed secrets. `PORT` is supplied by GoDaddy. `TRUST_PROXY=1` is optional and should only be set if the host confirms its proxy overwrites `X-Forwarded-For` and blocks direct public access to Node. Otherwise leave it unset; visitors behind the same proxy share rate limits.

For another compatible host, configure the same database variables for its MySQL service. This code does not require a database folder on the app's filesystem. Arrange scheduled database backups and a tested restore procedure with your hosting provider.

Official hosting guidance:

* https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/examples.md#managed-mysql
* https://developer.godaddy.com/en/docs/api-users/hosting/app-requirements

## Before accepting real bookings

1. Open `/admin` and sign in using your configured password.
2. Review opening date, hours, seat capacity and group limits. Check the phone, email, address and deposit policy against the restaurant's current details.
3. Arrange database backup and retention with the host. The privacy page is a factual description of this implementation, not a claim of completed legal compliance; review it for your actual hosting and operating arrangements.
4. Open bookings, submit one clearly labelled test request, and confirm it from another device. Verify its private status page changes.
5. Close a time window and verify it disappears from the booking page; reopen it and verify it returns.
6. Restart and then redeploy the application. Confirm the test booking and settings still exist. Successful restart alone does not verify the complete deployment setup. The same hosted MySQL database must remain connected after publishing.
7. Cancel the test booking. Only then make the booking link available to customers.

Use the existing website's Book a table buttons, or link from other pages directly to `https://YOUR-DOMAIN/book`. On iPhone, open `/admin` in Safari and use Share → Add to Home Screen for quick access. It remains a web application and needs internet access.

## Daily use

* Open **All pending requests**, review capacity and any group deposit, and press **Accept** or **Decline**.
* The list refreshes every 30 seconds while the dashboard is visible. There are no background push alerts when the page is closed.
* **Pause all bookings** stops new online requests immediately. **Open bookings** enables them again, subject to hours, dates and capacity.
* **Close / open dates** closes a full day or an arrival window. Closures do not alter existing reservations. Remove each overlapping closure to reopen fully.
* Use each guest's phone or **Email guest** link to contact them. The email link opens a prepared draft in your email app; you must send it yourself.
* Change a booking's status to Arrived, Completed, Cancelled or No show when appropriate. Cancelled and declined requests can be reopened as Pending if capacity permits.
* Export CSV for your own records, and store backups securely.

**No automatic email or SMS is configured.** Guests are told to save their private status link. Automatic delivery can be added later using a verified restaurant mailbox or mail service, but it requires configuration and may have provider costs. This application does not advertise delivery that has not been configured.

## Password and recovery

Change `ADMIN_PASSWORD` in the host settings and restart the application. Sessions created with the old password become invalid when requests are handled by the restarted application. Restart all app instances using the changed password. The password is never sent to the customer booking page. Staff sessions use HttpOnly, SameSite cookies, with Secure enforced in production, and expire after 12 hours.

Protect the hosting account: access to it permits password reset and database access. Use **Hosted Database > Export SQL** for a database export and keep it private. Arrange automated backups with your host. Restore only a verified backup into the intended database while both Preview and Publish are stopped, because they share data. Database imports can overwrite data; retain a fresh backup before a restore.

The JSON download is a portable data export, not an automatically importable database snapshot. A technician can use it for recovery/migration if necessary; no public restore endpoint is provided.

## Verification performed

Version 1.1.1 passed fourteen integration tests on Node 22.23.3 with a real, disposable MySQL 8.0.46 server:

* Request creation, manager approval, customer status and cancellation.
* Persistence after closing and restarting the app's database connections.
* Concurrent requests, peak occupancy, cancellation releasing capacity and retry idempotency.
* First opening date, invalid dates/times, closed dates/windows and pause/reopen.
* Manager authentication, CSRF, cross-origin rejection and secret status links.
* Private exports, safe CSV output and blocking source/database file routes.
* Europe/London dates and daylight-saving offsets.
* Missing database configuration fails closed.
* Two separate app instances share capacity, closures, settings and idempotency.
* Failed transactions roll back changes.
* The exact legacy payload table shown in the hosted database stays unchanged while a new reservation can be created, listed, accepted, exported, cancelled and retained across restart.
* Existing compatible v1.1.0 bookings and capacity remain available.
* Populated incompatible legacy records block startup and remain unchanged.
* Missing auxiliary-table columns produce a specific startup error.

Run tests only against a disposable **local** MySQL server. Set the five `DB_*` variables for a local test account with permission to create/drop databases named `bv_test_*`, and set `BV_TEST_MYSQL=1`. Then run `npm test`. The suite refuses a non-local database host and creates/drops only randomly named test databases. Never run it against the restaurant's hosted database.

The deployment package also passed GoDaddy's published validator in strict mode. A separate production-mode startup check verified the MySQL connection, paused initial settings, the admin page and a login cookie with Secure, HttpOnly and SameSite attributes.

Run `npm ci`, `npm run build`, then `npm start` for a normal deployment. The included `.env.example` is documentation only; configure real values through the host. No real guests were contacted during testing. End-to-end GoDaddy validation of v1.1.1 remains to be completed after upload.

## Ownership

The new application code is supplied for your use and modification. You can give this source to another developer and host it with a compatible provider. The retained website content remains from your supplied archive. System fonts are available as fallbacks; the page also requests fonts from Google Fonts. There is no subscription enforcement, remote licence check or reservation-provider integration in this code.
