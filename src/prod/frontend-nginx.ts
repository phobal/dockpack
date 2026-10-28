/** Runtime-only configuration: backend addresses never enter the frontend bundle. */
export const BACKEND_URL_VARIABLE = "BACKEND_URL";
export const backendEnvironment = {
  BACKEND_URL: "${BACKEND_URL:?Set BACKEND_URL to the backend origin, e.g. http://backend:8000}",
};

// Sourced before the official Nginx image's 20-envsubst-on-templates.sh.
export const backendEnvironmentScript = [
  "#!/bin/sh",
  "if [ -z \"$(printf '%s' \"${BACKEND_URL:-}\" | tr -d '\\r\\n')\" ] ||",
  "   [ \"$(printf '%s' \"${BACKEND_URL:-}\" | tr -d '\\r\\n')\" != \"${BACKEND_URL:-}\" ]; then",
  "  echo 'dockpack: BACKEND_URL is required and must be a single HTTP(S) origin, e.g. http://backend:8000' >&2",
  "  exit 1",
  "fi",
  "BACKEND_URL=\"${BACKEND_URL%/}\"",
  "if ! printf '%s\\n' \"$BACKEND_URL\" | grep -Eq '^https?://([A-Za-z0-9][A-Za-z0-9.-]*|\\[[0-9A-Fa-f:]+\\])(:[0-9]+)?$'; then",
  "  echo 'dockpack: BACKEND_URL must be an HTTP(S) origin without credentials, path or query, e.g. http://backend:8000' >&2",
  "  exit 1",
  "fi",
  "export BACKEND_URL",
  "export NGINX_ENVSUBST_FILTER='^BACKEND_URL$'",
  "",
].join("\n");

export function nginxTemplate(base: string): string {
  const proxy = [
    '        set $dockpack_backend "${BACKEND_URL}";',
    "        proxy_pass $dockpack_backend$request_uri;",
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $proxy_host;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_set_header Upgrade $http_upgrade;",
    "        proxy_set_header Connection $dockpack_connection;",
    "        proxy_ssl_server_name on;",
    "        proxy_buffering off;",
    "        proxy_cache off;",
    "        proxy_read_timeout 3600s;",
    "        proxy_send_timeout 3600s;",
  ];
  return [
    "map $http_upgrade $dockpack_connection {",
    "    default upgrade;",
    "    '' close;",
    "}",
    "server {",
    "    listen 80;", "    server_name _;", "    root /usr/share/nginx/html;", "    index index.html;",
    // Docker's embedded resolver also resolves external names via daemon DNS.
    "    resolver 127.0.0.11 valid=10s ipv6=off;",
    "    location = /api {", ...proxy, "    }",
    "    location ^~ /api/ {", ...proxy, "    }",
    ...(base === "/" ? [] : ["    location / { return 404; }", `    location = ${base.slice(0, -1)} { return 302 ${base}; }`]),
    `    location ${base} { try_files $uri $uri/ ${base}index.html; }`,
    "    location ~* \\.(?:js|mjs|css|map|json|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|wasm)$ { try_files $uri =404; }",
    "}", "",
  ].join("\n");
}
