# Deploy Umami with rootless Podman

The Podman stack builds this repository's source. It does not pull a mutable
upstream Umami application tag. PostgreSQL is pinned to the same immutable image
used by CI, runs only on an internal container network, and is not published on
the host.

## Start the stack

1. Copy `env.sample` to `.env`, set every required value, and restrict it to the
   current user:

   ```bash
   install -m 0600 env.sample .env
   ```

2. Build and start the checked-out source:

   ```bash
   podman-compose build
   podman-compose up -d
   ```

3. Put a trusted TLS reverse proxy in front of the loopback listener. The
   default host address is `127.0.0.1:3000`; set `UMAMI_PORT` in `.env` only
   when a different loopback port is needed.

Stop the stack with:

```bash
podman-compose down
```

## Install the user service

Edit `umami.service` and set `WorkingDirectory` to the absolute path of this
repository's `podman` directory. Secrets are intentionally not imported into
the systemd manager; Podman Compose reads the protected `.env` file directly.

Then install and start the service:

```bash
./install-systemd-user-service
```

The service rebuilds the checked-out source before starting it. If the stack is
already running outside systemd, stop it first with `podman-compose down`.

## Compatibility

These files should be compatible with podman 4.3+.

The baseline is Debian GNU/Linux 12 with Podman 4.3 and podman-compose 1.0.3 or
newer.
