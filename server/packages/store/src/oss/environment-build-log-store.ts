import OSS from "ali-oss";
import type { EnvironmentBuildLog, EnvironmentBuildLogStore } from "../interfaces/environment-build-log-store.js";
import { isMissingObject, type OSSArtifactStoreOptions } from "./artifact-store.js";

/** The SDK calls this store makes; tests inject a fixture. */
export interface OSSBuildLogClient {
  put(name: string, body: Buffer, options: { mime: string; meta: Record<string, string> }): Promise<unknown>;
  get(name: string): Promise<{ content?: Buffer; res: { headers: object } }>;
}

/** User metadata `x-oss-meta-log-start`: the byte offset of the kept text in the whole log. */
const START_META = "log-start";

/**
 * Environment Build logs as plain-text objects in the Host's Bucket, outside
 * every mounted Workspace prefix; the dropped head's length travels as user
 * metadata so readers can resume by offset.
 */
export class OSSEnvironmentBuildLogStore implements EnvironmentBuildLogStore {
  private readonly client: OSSBuildLogClient;

  constructor(options: OSSArtifactStoreOptions & { logClient?: OSSBuildLogClient }) {
    const { client: _client, logClient, publicEndpoint: _publicEndpoint, ...sdkOptions } = options;
    this.client = logClient ?? new OSS({ ...sdkOptions, secure: true, authorizationV4: true }) as unknown as OSSBuildLogClient;
  }

  async write(key: string, log: EnvironmentBuildLog): Promise<void> {
    await this.client.put(assertKey(key), Buffer.from(log.text, "utf8"), {
      mime: "text/plain; charset=utf-8",
      meta: { [START_META]: String(log.start) },
    });
  }

  async read(key: string): Promise<EnvironmentBuildLog | null> {
    let result: Awaited<ReturnType<OSSBuildLogClient["get"]>>;
    try {
      result = await this.client.get(assertKey(key));
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
    const header = Object.entries(result.res.headers).find(([name]) => name.toLowerCase() === `x-oss-meta-${START_META}`)?.[1];
    const start = Number(header ?? 0);
    return { text: (result.content ?? Buffer.alloc(0)).toString("utf8"), start: Number.isSafeInteger(start) && start >= 0 ? start : 0 };
  }
}

function assertKey(key: string): string {
  if (!/^__oma\/environment-builds\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\.log$/.test(key)) throw new Error("Invalid Environment Build log key");
  return key;
}
