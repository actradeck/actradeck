/**
 * INV-TEST-DB-GUARD-WIRING (sidecar projects・task 01a10f9f / QA-LRL-1): the sidecar vitest config
 * is split into projects, and each project receives the production-DB guard
 * (`./test/setup-env.ts`) only through the config it inherits. The event-model wiring test checks
 * the spelling of the root `setupFiles` line, which stays in place when a single project stops
 * inheriting it (deleting one `extends: true` dropped the guard for that project and the spelling
 * check stayed green). This test reads the config object itself: every project must end up with
 * the setup file, either by inheriting the root config or by listing it.
 */
import { describe, expect, it } from "vitest";

import config from "../vitest.config.js";

const SETUP_FILE = "./test/setup-env.ts";

type ProjectEntry = {
  extends?: unknown;
  test?: { name?: unknown; setupFiles?: unknown };
};

const listed = (setupFiles: unknown): readonly unknown[] =>
  Array.isArray(setupFiles) ? setupFiles : setupFiles === undefined ? [] : [setupFiles];

/** Whether a project ends up with the guard: its own list, or `extends: true` over a root that has it. */
function projectGetsGuard(entry: ProjectEntry, rootSetupFiles: unknown): boolean {
  if (listed(entry.test?.setupFiles).includes(SETUP_FILE)) return true;
  return entry.extends === true && listed(rootSetupFiles).includes(SETUP_FILE);
}

describe("INV-TEST-DB-GUARD-WIRING: every sidecar vitest project gets the production-DB guard", () => {
  const rootSetupFiles = config.test?.setupFiles;
  const projects = (config.test?.projects ?? []) as unknown[];

  it("the config defines the projects this test is about", () => {
    expect(projects.map((p) => (p as ProjectEntry).test?.name)).toEqual([
      "sidecar",
      "sidecar-timing",
    ]);
  });

  it("each project inherits or lists ./test/setup-env.ts", () => {
    let checked = 0;
    for (const entry of projects) {
      expect(typeof entry, "inline project objects, not path globs").toBe("object");
      const name = String((entry as ProjectEntry).test?.name);
      expect(projectGetsGuard(entry as ProjectEntry, rootSetupFiles), name).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the check rejects a project that neither inherits nor lists the guard", () => {
    const root = [SETUP_FILE];
    // POSITIVE: the two shapes that do get the guard.
    expect(projectGetsGuard({ extends: true, test: { name: "a" } }, root)).toBe(true);
    expect(projectGetsGuard({ test: { name: "b", setupFiles: [SETUP_FILE] } }, [])).toBe(true);
    // The shapes QA-LRL-1 measured: `extends` deleted, or set to false.
    expect(projectGetsGuard({ test: { name: "c" } }, root)).toBe(false);
    expect(projectGetsGuard({ extends: false, test: { name: "d" } }, root)).toBe(false);
    // `extends: true` over a root that lost the setup file.
    expect(projectGetsGuard({ extends: true, test: { name: "e" } }, [])).toBe(false);
  });
});
