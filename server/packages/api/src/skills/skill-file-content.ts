import { isUtf8 } from "node:buffer";
import { resolveArtifactContentType } from "@oma-server/store";

/** One Skill file as `GET /v1/skills/:id/files/content` returns it. */
export type SkillFileRead =
  | { path: string; content: string }
  | { path: string; binary: true; size: number; contentType: string };

/**
 * Media types the editor opens as text: the Workspace reader's text-like
 * types (web `file-source.ts`), without SVG, which it previews as an image.
 */
const TEXT_MEDIA_TYPE = /^(text\/|application\/(json|javascript|xml|x-yaml|yaml)(;|$))/;

/**
 * Present one Skill file (#269): text inline for the editor, anything else as
 * metadata whose bytes come from `GET /v1/skills/:id/files/raw`. The media
 * type comes from the extension, as for Workspace files
 * (`resolveArtifactContentType`). A file is binary when that type is known and
 * not text (images, audio, video, fonts, archives, PDF, SVG), or when its
 * bytes are not UTF-8 or contain NUL, so a text read never loses a byte.
 */
export function readSkillFile(path: string, bytes: Uint8Array): SkillFileRead {
  const contentType = resolveArtifactContentType(path);
  const nonTextType = contentType !== "application/octet-stream" && !TEXT_MEDIA_TYPE.test(contentType);
  if (nonTextType || !isUtf8(bytes) || bytes.includes(0)) {
    return { path, binary: true, size: bytes.byteLength, contentType };
  }
  // Keep a byte order mark, so saving the text writes back the bytes read.
  return { path, content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
}
