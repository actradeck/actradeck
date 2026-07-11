import type { Deps } from "../lib/types.js";
import { resolveRepo, ghcrImage } from "../lib/repo.js";

// `actradeck up` — GENERATE and PRINT the Docker cockpit bring-up command. It NEVER runs
// anything (the CLI does not execute Docker for you). The printed command is kept in lockstep
// with the canonical one in docs/docker.md (loopback publish + persistent pgdata volume).
export async function cmdUp(deps: Deps): Promise<number> {
  const slug = resolveRepo(deps.env);
  const image = `${ghcrImage(slug)}:latest`;

  deps.io.out(
    "# ActraDeck cockpit in Docker — copy & run this yourself (the CLI prints, it does not execute):",
  );
  deps.io.out("docker run --rm \\");
  deps.io.out("  -p 127.0.0.1:55400:55400 \\");
  deps.io.out("  -v actradeck_pgdata:/data \\");
  deps.io.out(`  ${image}`);
  deps.io.out("# then open http://localhost:55400");
  deps.io.out("#");
  deps.io.out(
    "# Notes: -p binds loopback ONLY (single-operator by design); -v persists the embedded DB.",
  );
  deps.io.out(
    "# The container is the cockpit stack; observing your own agents needs a host-side sidecar.",
  );
  deps.io.out("# See docs/docker.md for verifying the image signature and wiring the sidecar.");
  return 0;
}
