# Nginx files, Docker paths and Uptime Kuma

How to give Orb your reverse proxy's files, how the paths line up, how to keep
your own Docker changes in an override file, and how Orb fills Uptime Kuma
with monitors for your sites and its own apps.

## The nginx folder: paths

A mount has two sides: `host path:container path:ro`. Orb only ever sees the
right-hand side, so `NGINX_CONF_DIR` is always that container path, never
the Unraid path. Use `/nginx` and you never have to think about it again:

```yaml
volumes:
  - /mnt/user/appdata/nginx-proxy-manager/data/nginx/proxy_host:/nginx:ro
environment:
  NGINX_CONF_DIR: /nginx
```

Orb reads every `*.conf` under `/nginx`, up to 4 folders deep and 400 files,
skipping `*.sample`. From each `server { }` block it takes the names
(`server_name`), whether it serves https (`listen 443` or `ssl`) and where
it sends traffic (`proxy_pass http://host:port`, SWAG's `$upstream_app` /
`$upstream_port`, or Nginx Proxy Manager's `$server` / `$port`). Always mount
read only: Orb never writes there.

Which host folder to mount:

| Your proxy | Host folder (Unraid default) | Notes |
|---|---|---|
| Nginx Proxy Manager, official image (`jc21/nginx-proxy-manager`) | `/mnt/user/appdata/nginx-proxy-manager/data/nginx/proxy_host` | Only `proxy_host`. The rest of `data` holds NPM's database, and `letsencrypt` holds certificate keys: Orb needs neither. |
| Nginx Proxy Manager, `jlesage/nginx-proxy-manager` (Community Apps) | `/mnt/user/appdata/NginxProxyManager/nginx/proxy_host` | Same files, different appdata layout. |
| SWAG (`linuxserver/swag`) | `/mnt/user/appdata/swag/nginx` | The whole `nginx` folder (it has `proxy-confs` and `site-confs`). Set `NGINX_DOMAIN` (e.g. `thefellashub.com`): SWAG's files say `server_name sonarr.*;`. |
| Plain nginx on the host | `/etc/nginx` | The whole folder, so `sites-enabled`'s links into `sites-available` still lead somewhere inside the mount. |

Not sure where your files are? On the Unraid terminal:

```bash
find /mnt/user/appdata -path '*proxy_host*' -name '*.conf' | head
```

```bash
find /mnt/user/appdata -name '*.subdomain.conf' -not -name '*.sample' | head
```

The folder that holds the `.conf` files (or the `nginx` folder above
`proxy-confs` for SWAG) is the one to mount.

**Check it:** Settings → Connections → nginx → **Test** says how many
proxied sites it found. 0 means the mount points at the wrong folder (open a
shell in the container: `docker exec pondering-orb ls -R /nginx | head`), or
SWAG's domain isn't set.

Nginx Proxy Manager can also be read through its API instead
(`NPM_URL`, `NPM_EMAIL`, `NPM_PASSWORD`); the files need no login. Using both
is fine: the same site found twice counts once.

## Your changes in an override file

`docker-compose.yml` is the example you copied; your paths, networks and
extras go in `docker-compose.override.yml`, which Docker Compose reads on its
own on every `docker compose up`. A new example can then replace
`docker-compose.yml` without losing anything.

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
```

```bash
docker compose config
```

`docker compose config` prints the merged file: check the volumes and
networks are what you expect before `docker compose up -d`.

How the two files combine:

- **Lists add up**: `volumes`, `ports`, `networks` in the override are added to
  the base file's. A volume with the **same container path** replaces the
  base one (that's how the example moves Uptime Kuma's data to appdata).
- **Single values replace**: an `environment` entry, `image`, `restart`.
- **External networks**: the apps you already run made their own networks
  (`proxynat`, `ai_net`). Declare them `external: true` and list them under
  the service; Orb then reaches those apps by container name
  (`http://milaclone-app:4321`). Addresses Orb opens **in your browser**
  (Milaclone in the Ideas tab, Hermes Studio's links) still need a LAN or
  proxied address, because your browser isn't on the Docker network.
- **Bundled Uptime Kuma**: add `COMPOSE_PROFILES=uptime` to `.env` (or run
  `docker compose --profile uptime up -d`) and set
  `UPTIME_URL=http://uptime-kuma:3001`.

## Uptime Kuma: monitors for your sites and Orb's apps

Settings → Scripts → **Watch sites and apps in Uptime Kuma** (by hand or on
a schedule) adds a monitor for everything not watched yet, each in its own
section of Orb's status page:

| Section | What | Up when |
|---|---|---|
| **Websites** | Every name your reverse proxy serves (the nginx files above, or NPM's API), https when the proxy has a certificate | the page loads, redirects, or asks you to sign in (2xx, 3xx, 401, 403) |
| **Pondering apps** (on unless the option says `no`) | Every app Orb is connected to, on the address Orb uses: Hermes Studio, UpstreamManager, ALLGlance, LLMWIKI, Golem's model (`/v1/models`), Milaclone (`/api/health`), Coinpile (`/health`), Firefly III, Omi, the Unraid agent, Nginx Proxy Manager, Technitium | it answers at all (2xx to 4xx: an API that wants a key still answers 401) |
| **Server apps** (option `yes`; off by default) | Running Unraid containers with a web port that the proxy doesn't serve, on the server's LAN address | it answers (2xx to 4xx) |

It needs an Uptime Kuma admin login in `UPTIME_KUMA_USER` and
`UPTIME_KUMA_PASSWORD` (Kuma 1.x has no API key for this). A monitor it adds
is marked as Orb's in its description, with its section. When the site or
app goes away, Orb pauses its monitor rather than deleting it, and resumes it if
it comes back. Monitors you made, and sections you made on the status page,
are never changed. To leave something out, put part of its name in **Never
watch** (`guac, test.example.com, omi`).

Adding an app later is the same as for Orb: connect it in Settings →
Connections (or the apps YAML), and the next run watches it.
