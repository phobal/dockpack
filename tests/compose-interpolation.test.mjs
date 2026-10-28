import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeCompose, detectComposeCommand, resolveComposeModel } from "../dist/compose/inspect.js";

test("service analysis resolves image defaults and .env overrides while deployment models retain variables", { skip: !detectComposeCommand() }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockpack-compose-"));
  try {
    await writeFile(path.join(root, "compose.yaml"), 'services:\n  office:\n    image: ${DOCKPACK_TEST_OFFICE_IMAGE:-onlyoffice/documentserver:latest}\n');
    const defaults = await analyzeCompose(root, ["compose.yaml"]);
    assert.equal(defaults.normalized, true);
    assert.equal(defaults.services[0].image, "onlyoffice/documentserver:latest");
    await writeFile(path.join(root, ".env"), "DOCKPACK_TEST_OFFICE_IMAGE=example/office:pinned\n");
    const overridden = await analyzeCompose(root, ["compose.yaml"]);
    assert.equal(overridden.services[0].image, "example/office:pinned");
    const deployment = await resolveComposeModel(root, ["compose.yaml"]);
    assert.equal(deployment.services.office.image, "${DOCKPACK_TEST_OFFICE_IMAGE:-onlyoffice/documentserver:latest}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
