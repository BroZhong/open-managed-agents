// Guard test for the stylesheet next door. It lives here, beside index.css,
// rather than with the component tests because the invariant belongs to the
// stylesheet: AssistantBubble's `prose prose-sm prose-neutral` classes only
// exist if Tailwind v4 is told to load @tailwindcss/typography, and v4 has no
// config file — the sole switch is the `@plugin` at-rule in index.css.
//
// Issue #117 was exactly this being absent: the classes were silently dead, so
// every markdown element (tables worst of all) fell back to browser defaults.
// A DOM test cannot see it, because jsdom applies no stylesheet. So assert the
// two halves of the wiring directly, and fail loudly if an edit drops either.

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

it("loads the typography plugin, which is what generates the prose* classes", () => {
  const css = read("./index.css");

  expect(css).toContain('@plugin "@tailwindcss/typography"');
  // Tailwind requires @plugin to follow the @import that establishes the
  // build; ordering it before would be a hard build error.
  expect(css.indexOf('@import "tailwindcss"')).toBeLessThan(
    css.indexOf('@plugin "@tailwindcss/typography"'),
  );
});

it("declares the typography plugin as a dependency so @plugin can resolve", () => {
  const pkg = JSON.parse(read("../package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  expect({ ...pkg.dependencies, ...pkg.devDependencies }).toHaveProperty(
    "@tailwindcss/typography",
  );
});
