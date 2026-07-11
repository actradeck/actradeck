import { describe, it, expect } from "vitest";
import { cmdDoctor, nodeMajor } from "./doctor.js";
import { makeFakeDeps } from "../lib/fake.js";

describe("nodeMajor", () => {
  it("extracts the major or null", () => {
    expect(nodeMajor("v22.16.0")).toBe(22);
    expect(nodeMajor("20.0.0")).toBe(20);
    expect(nodeMajor("weird")).toBeNull();
  });
});

describe("cmdDoctor", () => {
  it("passes (exit 0) when Node>=20 and pnpm present", async () => {
    const f = makeFakeDeps({
      nodeVersion: "v22.16.0",
      tools: {
        pnpm: { stdout: "10.28.2\n" },
        git: { stdout: "git version 2.43.0\n" },
        docker: { stdout: "Docker version 27.0.0\n" },
      },
    });
    expect(await cmdDoctor(f.deps)).toBe(0);
    const text = f.out.join("\n");
    expect(text).toMatch(/\[ok {2}\] node/);
    expect(text).toMatch(/\[ok {2}\] pnpm {6}10\.28\.2/);
    expect(text).toMatch(/all required prerequisites present/);
  });

  it("fails (exit 1) when Node is too old", async () => {
    const f = makeFakeDeps({ nodeVersion: "v18.19.0", tools: { pnpm: { stdout: "10.0.0" } } });
    expect(await cmdDoctor(f.deps)).toBe(1);
    expect(f.out.join("\n")).toMatch(/\[FAIL\] node/);
    expect(f.err.join("\n")).toMatch(/required prerequisite is missing/);
  });

  it("fails (exit 1) when pnpm is missing but only warns for git/docker", async () => {
    const f = makeFakeDeps({ nodeVersion: "v22.16.0", tools: {} });
    expect(await cmdDoctor(f.deps)).toBe(1);
    const text = f.out.join("\n");
    expect(text).toMatch(/\[FAIL\] pnpm/);
    expect(text).toMatch(/\[warn\] git/);
    expect(text).toMatch(/\[warn\] docker/);
  });

  it("treats a present-but-erroring tool as absent, and reports 'version unknown' on empty output", async () => {
    const f = makeFakeDeps({
      nodeVersion: "v22.16.0",
      tools: { pnpm: { code: 1, stdout: "boom" }, git: { stdout: "" } },
    });
    expect(await cmdDoctor(f.deps)).toBe(1); // pnpm errored -> required missing
    const text = f.out.join("\n");
    expect(text).toMatch(/\[FAIL\] pnpm/);
    expect(text).toMatch(/git version unknown|git \(version unknown\)/);
  });
});
