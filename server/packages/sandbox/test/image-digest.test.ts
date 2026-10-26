import { describe, expect, it } from "vitest";
import { imageDigest, isDigestPinnedImage } from "../src/index.js";

const DIGEST = `sha256:${"a1".repeat(32)}`;

describe("image references pinned by digest", () => {
  it("reads the digest of a pinned image, with or without a registry port", () => {
    expect(imageDigest(`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@${DIGEST}`)).toBe(DIGEST);
    expect(imageDigest(`localhost:5000/oma@${DIGEST}`)).toBe(DIGEST);
  });

  it("refuses a tag, a tag with a digest, or no digest at all", () => {
    for (const image of ["welltop/oma-sandbox:0.1.2", `welltop/oma-sandbox:0.1.2@${DIGEST}`, "welltop/oma-sandbox@sha256:abc"]) {
      expect(isDigestPinnedImage(image)).toBe(false);
      expect(() => imageDigest(image)).toThrow("is not an image pinned by digest");
    }
  });
});
