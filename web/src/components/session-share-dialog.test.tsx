// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionShareDialog } from "./session-share-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("creates only on copy, retains the same link after clipboard failure and re-opening", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const fetcher = vi.fn(async () => Response.json({ id: "permanent-share" }));
  vi.stubGlobal("fetch", fetcher);
  const writeText = vi.fn().mockRejectedValueOnce(new Error("Clipboard denied")).mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<SessionShareDialog sessionId="session1" title="My Session" events={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "分享" }));
  expect(screen.getByRole("dialog").textContent).toContain("My Session");
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "分享" }));
  fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
  await screen.findByRole("button", { name: "已复制" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/share/permanent-share`);
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "分享" }));
  fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
  await screen.findByRole("button", { name: "已复制" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
