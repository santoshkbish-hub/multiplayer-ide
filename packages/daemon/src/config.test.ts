import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER_IMAGE } from "./container/types.js";
import { loadConfigFromEnv } from "./config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    HOME: "/tmp/home",
    COLLAB_REPO_ROOT: "/tmp/repo",
    COLLAB_HOST_TOKEN: "host-token",
  };
}

describe("daemon config", () => {
  it("uses the git-capable default container image", () => {
    const config = loadConfigFromEnv(baseEnv());
    expect(config.containerImage).toBe(DEFAULT_CONTAINER_IMAGE);
  });

  it("allows the container image to be overridden by env", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      COLLAB_CONTAINER_IMAGE: "custom/agent:dev",
    });
    expect(config.containerImage).toBe("custom/agent:dev");
  });
});
