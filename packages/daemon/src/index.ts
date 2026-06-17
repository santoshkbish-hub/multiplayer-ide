import { loadConfigFromEnv } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

export { Orchestrator } from "./orchestrator.js";
export { loadConfigFromEnv, type DaemonConfig } from "./config.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigFromEnv();
  const orch = new Orchestrator(config);
  orch
    .start()
    .then(({ adminPort }) => {
      console.log(
        JSON.stringify({
          name: "daemon",
          relay: config.relayUrl,
          admin_port: adminPort,
          repo: config.repoRoot,
          worktrees: config.worktreesRoot,
        }),
      );
    })
    .catch((e) => {
      console.error("daemon start failed:", (e as Error).message);
      process.exit(1);
    });

  const shutdown = async () => {
    try {
      await orch.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
