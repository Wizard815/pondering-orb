# Links and the Unraid Management Agent

The **Links** tab is a grid of icons, one per app with a web page. Click one
to open the app in a new tab.

## Where the apps come from

- **Your Unraid server's containers**, from the
  [Unraid Management Agent](https://forums.unraid.net/topic/196675-plugin-unraid-management-agent)
  plugin: name, running or stopped, port mappings, and whether an update is
  waiting (↑).
- **Unraid's WebUI address and icon** for each container. Unraid keeps them as
  Docker labels (`net.unraid.docker.webui`, `net.unraid.docker.icon`), which
  the agent doesn't pass on, so Orb reads them through the read-only Docker
  socket proxy from the compose file (when Orb runs on the Unraid server).
  Without the proxy, a container's link is its first TCP port.
- **The apps list** (Settings → Apps), grouped by its groups.
- **Links you add** (Arrange → Add link), for anything else: the router, a
  NAS page, a website.

Either the agent or the Docker proxy is enough to list containers; with both,
Orb merges them.

## Connect the agent

1. Install the Unraid Management Agent plugin and set an API token in its
   settings.
2. In `.env`: `UNRAID_URL=http://tower:8043` and `UNRAID_TOKEN=<the token>`.
   Or Settings → Connections → Unraid Management Agent, with the name of the
   variable that holds the token.
3. Press **Test**: it names the server, its Unraid version and how many
   containers it found.

Links fall back to the server's LAN address (see below). Set
**Server's LAN address for app links** (`UNRAID_LINK_HOST`, e.g.
`192.168.20.5`) to choose it yourself.

Orb only reads from the agent; it never starts, stops or changes anything.

## Which address a link uses

Orb never builds a link from the address you opened Orb with: behind a
reverse proxy, `orb.example.com:8989` doesn't answer. For each app it uses,
in order:

1. **Its name on your reverse proxy**, when the proxy knows the app:
   - **Nginx Proxy Manager** (`NPM_URL`, `NPM_EMAIL`, `NPM_PASSWORD`): its
     proxy hosts, read only. A host that forwards to the server's address and
     the app's port, or to the container by name, becomes
     `https://sonarr.example.com` (http when it has no certificate). Disabled
     hosts don't count.
   - **nginx or SWAG configs** mounted read only (`NGINX_CONF_DIR`): each
     `server` block's `server_name` and `proxy_pass http://host:port`, or
     SWAG's `set $upstream_app` / `$upstream_port`. SWAG's `sonarr.*` names
     need your domain (`NGINX_DOMAIN`). `.sample` files are skipped.
2. **Its DNS name** in **Technitium DNS** (`TECHNITIUM_URL`,
   `TECHNITIUM_TOKEN`): an A record named after the app (`plex.home.lan`) that
   points at the server, with the app's port: `http://plex.home.lan:32400`.
3. **The server's LAN address** and the app's port, e.g.
   `http://192.168.20.5:8989`. The address is `UNRAID_LINK_HOST` if you set
   it, else the Unraid agent's address (looked up if it is a name), else the
   LAN address the agent reports.

Proxy and DNS lists are read every five minutes. A tile's tooltip says which
of these its link came from, and the Links page says which server address it
used. **Found on your server** also suggests Nginx Proxy Manager's and
Technitium's addresses when it sees their containers. Orb's own connections
(UpstreamManager, Uptime Kuma, ...) keep using the LAN address: they are
server to server.

## Arrange

Press **Arrange**:

- Drag an icon onto another to put it before or after it, or onto a category
  to move it there. It works with a mouse, a finger or a pen.
- The eye hides or shows an app. Hidden apps only show while arranging.
- ✎ edits an app: its name, category, icon address, and its link:
  - **Detected**: Unraid's WebUI, or the first port the container publishes.
  - **A port on the server**: pick one of the container's ports or type one
    (for host-network containers such as Home Assistant), http or https.
  - **Another address**: any URL, for an app behind a reverse proxy.
- **New category**, and ↑ ↓ and **Rename** on each category. An empty
  category can be removed.

Everything is saved in Orb (`settings/links`), so every browser sees the same
grid.

## Found on your server

Settings → **Found on your server** lists Orb connections that are still
empty (ALLGlance gateway, UpstreamManager, Uptime Kuma, Hermes Studio, the
wiki) next to the container that looks like it, with its address. **Use**
fills the connection in; press **Test** under Connections to check it.
