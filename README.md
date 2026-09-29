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
