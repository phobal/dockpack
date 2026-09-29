# dockpack CLI

TypeScript implementation of Dockpack. The package exposes the global `dockpack` executable through npm's `bin` mapping.

## Requirements

- Node.js 20 or newer to develop the CLI.
- Docker on machines that create or run offline bundles.
- Docker Compose v2 (`docker compose`) or legacy Compose (`docker-compose`).

## Local development

```sh
npm install
npm run build
node dist/cli.js init /path/to/project
```

## Global installation

After publishing the package to npm:

```sh
npm install --global dockpack-cli
dockpack --help
```

## Implemented commands

```sh
dockpack init [project-directory]
dockpack pack dev [project-directory] --output <archive>
dockpack pack inspect <archive>
dockpack import <archive>
dockpack dev init [project-directory] --bundle <archive>
dockpack dev start [project-directory]
dockpack dev stop [project-directory]
dockpack dev exec [project-directory] -- <command>
dockpack dev rebuild [project-directory]
dockpack build prod [project-directory] --output <archive>
dockpack prod inspect <archive>
dockpack deploy import|up|down|status|logs|backup|restore <archive>
```

Python dependency collection currently supports `requirements.txt` through pip; Node.js collection supports npm `package-lock.json`. Other package managers are detected and reported but rejected by bundle creation until their offline cache adapters are implemented.

## Portable project state

`dockpack dev init` writes local state under `.dockpack/`. The generated `.dockpack/compose.dev.yaml` uses `${DOCKPACK_PROJECT_DIR}` for the source mount; Dockpack sets it to the project path for each Compose invocation. The machine-local dependency cache is mounted only by a temporary `.dockpack/compose.install.yaml` during `dev init` or `dev rebuild`, then removed. No cache or source absolute path is persisted in the overlay or state file.

On another machine, copy or check out the source at its desired location, bring the development bundle, run `dockpack init <project-directory>` if `.dockpack.yaml` is not present, then run `dockpack dev init <project-directory> --bundle <bundle>`. This imports the bundle into that machine's XDG cache and creates a local dependency volume. Use Dockpack commands to run the generated Compose overlay; invoking it directly requires setting `DOCKPACK_PROJECT_DIR` yourself.

`dockpack dev init` and `dockpack dev rebuild` prepare the dependency volume without starting services. `dockpack dev start [project-directory]` starts the development Compose services in the foreground and streams their output. For Node projects whose `dev` script invokes Vite, Dockpack adds `--host 0.0.0.0`, maps the detected port (or Vite's default `5173`) to the host, and prints the local URL. Press `Ctrl+C` to stop and remove the containers for services started by this session; named dependency volumes and unselected service containers are preserved. For other projects, set `application.dev_command` and optionally `application.dev_port` in `.dockpack.yaml`, for example:

```yaml
application:
  dev_command: [npm, run, dev, --, --host, 0.0.0.0]
  dev_port: 5173
```

`dockpack init` checks the project root and a single unambiguous nested Compose project (up to four directory levels). It reads Node runtime hints from `.nvmrc`, `.node-version`, `.tool-versions`, `package.json` `engines.node`, and explicit `NODE_VERSION` assignments in common setup scripts. It may infer `application.build_command` from a project deployment script; review the generated config before packaging.

Production packaging can use an application service's existing root `Dockerfile` and the configured build command. `dockpack pack dev` includes amd64 base images referenced by the root Dockerfile for later production builds. The production Compose bundle rewrites project-local bind mounts to relative paths under its `runtime/` directory; those directories start empty, so existing host data is not included.
