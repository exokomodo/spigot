# Spigot

An RSS manager, allowing for publishing to a set of managed RSS feeds.

## Development

### Prerequisites

- **Node.js 22** — the version is pinned in [.nvmrc](.nvmrc), and
  `package.json` requires `>=22.0.0`.
- **make** — every workflow is wrapped in a target. Run `make` or `make help`
  to list them.
- A C toolchain, since `sqlite3` builds a native binding. macOS needs the
  Xcode command line tools (`xcode-select --install`); Debian/Ubuntu needs
  `build-essential` and `python3`.

### Setup

```sh
make setup
```

This installs `nvm` if it is missing, installs the Node version from
[.nvmrc](.nvmrc), and runs `npm install`. If you already manage Node yourself,
`make deps` just does the `npm install`.

Then create your local environment file:

```sh
cp .env.example .env
```

The `Makefile` auto-loads `.env` and exports it into every target, so anything
you put there applies to `make run`, `make test`, and friends.

### Configuration

All configuration is read from the environment in
[src/lib/config.ts](src/lib/config.ts):

| Variable             | Default           | Purpose                    |
| -------------------- | ----------------- | -------------------------- |
| `HOST`               | `0.0.0.0`         | Interface the server binds |
| `PORT`               | `3000`            | Port the server binds to   |
| `NODE_ENV`           | `development`     | Environment name           |
| `DATABASE_FILE_PATH` | `database.sqlite` | SQLite file, made on boot  |

In production the systemd unit sets `HOST=127.0.0.1`, so the app is reachable
only through nginx and never directly from the internet.

`.env` and `*.sqlite` are both gitignored, so your local database and secrets
stay out of commits.

### Running

```sh
make run
```

Runs [src/main.ts](src/main.ts) directly through `tsx` — no build step, no
separate compile process. The server logs its URL on boot:

```text
Server is running on http://0.0.0.0:3000
```

Verify it with `curl localhost:3000`, which hits the route defined in
[src/controllers/index.ts](src/controllers/index.ts).

`make run` does not reload on file changes; restart it after an edit. To
type-check continuously in a second terminal, use `make watch`
(`tsc --watch`).

To exercise the compiled output the way production does:

```sh
make build && npm start
```

`make clean` removes `build/` and `tmp/` when stale artifacts pile up.

### Testing

```sh
make test
```

Runs [Vitest](https://vitest.dev) once. For a red-green loop while you work,
use `npm run test:watch`. Tests live next to the code they cover as
`*.test.ts` — see [src/lib/config.test.ts](src/lib/config.test.ts).

### Code quality

```sh
make check   # ESLint, tsc --noEmit, Prettier check, markdownlint
make fix     # auto-fix all of the above
make format  # Prettier only
```

`make check` runs the linters serially and fails on the first error. Run it
before pushing — CI runs the same targets, and the formatting job fails if
`make format` produces a diff.

### Adding a route

Routes are grouped into controllers. A controller declares a `basePath` and a
list of routes, and handlers receive a request carrying the shared
[Dependencies](src/lib/dependencies.ts) object (the database handle today) on
`req.deps`:

```ts
const FeedsController: Controller<Dependencies> = {
  basePath: "/feeds",
  routes: [
    {
      path: "/",
      method: "GET",
      handler: async (req, res) => {
        const db = req.deps.db.instance;
        res.json(await db.all("SELECT * FROM feeds"));
      },
    },
  ],
};
```

Register it by adding it to the controller list in
[src/main.ts](src/main.ts).

### Project layout

```text
src/
  main.ts           # Entrypoint: config, DB, controllers, listen
  controllers/      # Route definitions, one controller per resource
  lib/
    config.ts       # Environment parsing
    database.ts     # SQLite connection
    dependencies.ts # The dependency bag handed to every handler
    rest/           # Thin typed layer over Express
```

### Continuous integration

Two workflows run on pull requests to `main`:

- [check.yml](.github/workflows/check.yml) — `make deps`, `make format` (must
  produce no diff), `make check`
- [ci.yml](.github/workflows/ci.yml) — `make deps`, `make build`, `make test`

Running `make fix && make check && make test` locally covers everything both
workflows do.

## Deployment

One Linux box runs two things: systemd supervises the Node process on
`127.0.0.1:3000`, and nginx serves port 80 and proxies to it. Nothing else —
no containers, no process manager.

### Server prerequisites

- Debian/Ubuntu with systemd
- `nginx`
- `git`, `make`, and a C toolchain (`build-essential`, `python3`) for the
  `sqlite3` native binding
- `nvm`, or the Node version from [.nvmrc](.nvmrc) installed system-wide
- A deploy user with `NOPASSWD` sudo, so CD can write `/etc` and restart units

Bootstrap once, as the deploy user:

```sh
sudo install -d -o "$USER" /srv/spigot
git clone https://github.com/exokomodo/spigot.git /srv/spigot
cd /srv/spigot
make deploy/doctor   # names anything still missing, and how to fix it
```

### Configuration files

Both live in [etc/](etc/) and are templates — `@PLACEHOLDER@` tokens are
substituted from the `Makefile` variables at install time, so the port and
server name have exactly one source of truth.

- [etc/nginx/spigot.conf](etc/nginx/spigot.conf) →
  `/etc/nginx/sites-available/spigot.conf`, symlinked into `sites-enabled/`
  (the stock `default` site is removed, since it also claims port 80)
- [etc/systemd/spigot.service](etc/systemd/spigot.service) →
  `/etc/systemd/system/spigot.service`
- [etc/systemd/spigot.env.example](etc/systemd/spigot.env.example) →
  `/etc/spigot/spigot.env`, only if that file does not exist yet

`/etc/spigot/spigot.env` is for host-specific overrides and secrets. Deploys
never overwrite it.

### Deploying

```sh
make deploy
```

Run on the server, it checks prerequisites, fast-forwards the checkout to
`origin/main`, runs `npm ci && npm run build`, installs both config files,
reloads nginx, and restarts `spigot.service` — failing loudly with the last 50
journal lines if the service does not come back up.

Useful overrides:

```sh
make deploy SERVER_NAME=spigot.example.com APP_PORT=3000
make deploy/release   # rebuild and reinstall without pulling
make deploy/status    # unit status plus recent logs
make deploy/logs      # journalctl -f
```

### Continuous deployment

[cd.yml](.github/workflows/cd.yml) runs on every push to `main`: it loads the
deploy key, then SSHes in and runs `make deploy`. All of the deploy logic lives
in the `Makefile`, so it behaves identically by hand.

Repository secrets: `SSH_PRIVATE_KEY`, `SSH_USER`, `SSH_HOST`, and
`SSH_KNOWN_HOSTS` (the output of `ssh-keyscan <host>`; without it the workflow
falls back to trusting whatever key the host presents).
Repository variables: `DEPLOY_DIR` (default `/srv/spigot`), `SERVER_NAME`,
`APP_PORT`.

### TLS

The site ships with `server_name _` on port 80 only. Once DNS points at the
box, set the `SERVER_NAME` variable, deploy, and run
`sudo certbot --nginx -d spigot.example.com`. Certbot edits the installed copy;
the next deploy overwrites it, so fold the TLS block back into
[etc/nginx/spigot.conf](etc/nginx/spigot.conf) when you set it up.
