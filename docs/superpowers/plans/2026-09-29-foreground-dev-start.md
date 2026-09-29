# Foreground Development Start Implementation Plan

> **For agentic workers:** Implement this plan inline in the current session and preserve all unrelated working-tree changes.

**Goal:** Make Dockpack start inferred Vite development servers in the foreground and remove the development Compose stack when the command exits.

**Architecture:** Add optional development command and port settings to the validated config, infer Vite defaults during `dockpack init`, and render them into the generated dev overlay. Add an asynchronous attached Compose runner so `dev start` can stream output and handle process signals, then always clean the Compose project with `down` while preserving named volumes.

**Tech Stack:** Node.js 20+, TypeScript, Zod, Docker Compose.

---

### Task 1: Development server configuration and inference

**Files:** `src/config/schema.ts`, `src/project/detect.ts`, `src/commands/init.ts`.

- Add `application.dev_command: string[]` and `application.dev_port: integer | null` with backward-compatible defaults.
- Infer Node `scripts.dev` when it invokes Vite; return `npm run dev -- --host 0.0.0.0 --port <port>` and infer the script's explicit port or Vite's default `5173`.
- Write inferred values from `dockpack init` into generated config.

### Task 2: Development overlay and foreground lifecycle

**Files:** `src/dev/project.ts`, `src/compose/command.ts`.

- Generate the dev container command from `dev_command`; keep `sleep infinity` for environments without one.
- Add host port mapping when `dev_port` is configured.
- Add an asynchronous Compose runner that streams logs and settles on exit or signal.
- Run `compose up` attached from `startDev`, and always call `compose rm -sf` for the selected services after it exits; this removes those containers without removing networks, dependency volumes, or unselected service containers.

### Task 3: User-facing behavior and verification

**Files:** `README.md`.

- Document foreground start, inferred Vite URL/port, exit cleanup, and the config fields for projects that need manual settings.
- Run `npm run build` and inspect the generated CLI/config behavior.
