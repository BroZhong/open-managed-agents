import type { EnvironmentBuildLog, EnvironmentBuildLogStore } from "@oma-server/store";

/** In-memory {@link EnvironmentBuildLogStore}, for tests and the local profile. */
export class InMemoryEnvironmentBuildLogStore implements EnvironmentBuildLogStore {
  readonly logs = new Map<string, EnvironmentBuildLog>();

  async write(key: string, log: EnvironmentBuildLog): Promise<void> {
    this.logs.set(key, { ...log });
  }

  async read(key: string): Promise<EnvironmentBuildLog | null> {
    const log = this.logs.get(key);
    return log ? { ...log } : null;
  }
}
