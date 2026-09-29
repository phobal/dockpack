# Foreground Development Start Design

## Goal

Make `dockpack dev start [project-directory]` behave like a local development command: start the configured development server in Docker, keep logs attached to the current terminal, and stop and remove the Dockpack development containers when the user exits.

## Current behavior

The generated development overlay runs `sleep infinity`. `startDev` invokes Compose with `up -d`, so the command returns immediately and does not expose a web development server. The project configuration currently stores the production `application.command` and `application.port`; it does not define a development command or development port.

## Design

1. Add development server settings to `.dockpack.yaml`, separate from production settings: `application.dev_command` and `application.dev_port`.
2. During `dockpack init`, infer a development command and port from supported project metadata. For a Node project with a Vite `dev` script, run the script with Vite bound to `0.0.0.0`; use the configured or detected Vite port and map it to the host. Projects without a safe inference receive actionable guidance to configure these fields manually.
3. Generate the Dockpack Compose overlay with the configured development command and port mapping. Keep the existing long-running idle command for environments without a configured dev server so `dev exec` remains usable.
4. Change `dockpack dev start` to run Compose in attached mode. Forward terminal signals, and on normal exit, Ctrl+C, or termination signals, run Compose `down` for the project services so Dockpack-created containers are removed. Preserve dependency volumes and source files.
5. Keep `dev stop` available for stopping a started environment from another terminal; its existing stop semantics remain unchanged.

## Lifecycle and errors

The command validates imported bundle state and locked dependency inputs before starting, as it does today. A Compose startup failure is reported as a failed command. Cleanup is attempted after Compose exits; cleanup errors are reported without hiding the original startup or runtime error. The command does not remove named dependency volumes, images, or user data volumes.

## Verification

- Verify Vite inference includes `--host 0.0.0.0` and the expected port mapping.
- Verify unconfigured projects retain the idle-container behavior and receive clear setup guidance when the user expects a dev server.
- Verify attached Compose invocation has no detached flag.
- Verify Ctrl+C / termination triggers Compose `down`, while preserving dependency volumes.
- Run the project build and relevant CLI checks.

## Scope

This change covers the Dockpack-managed development services. It does not change production deployment Compose behavior, permit adding dependencies offline, or remove Docker images and named dependency volumes.
