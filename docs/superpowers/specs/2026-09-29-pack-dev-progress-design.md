# Pack Dev Progress Output Design

## Goal

Make long-running `dockpack pack dev` operations visible so developers can tell which stage is active and see progress while Docker or Compose work is running.

## Design

- Print concise named stages for configuration and project detection, runtime/dependency preparation, Compose infrastructure handling, image export, and archive creation.
- Report elapsed time when each stage completes. If a stage fails, identify the stage and preserve the original error details.
- Forward subprocess output live for Docker image pulls, dependency collection, Compose builds, and image saves invoked by `pack dev`.
- Keep current output behavior for other Dockpack commands. Do not add a quiet/verbose mode in this change.

## Scope and boundaries

Progress reporting is limited to development bundle creation. Existing DockerRunner and Compose helpers should gain an opt-in streaming mode so unrelated commands retain their current captured-output behavior. The final archive-created message remains the CLI's responsibility.

## Verification

- Build the TypeScript CLI.
- Run a development bundle creation and confirm stage labels and long-running subprocess output are visible, including failures.
- Confirm other commands continue using their existing output behavior.
