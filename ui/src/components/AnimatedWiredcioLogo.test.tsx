// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WiredcioLoading } from "./AnimatedWiredcioLogo";

describe("WiredcioLoading", () => {
  it("renders an accessible full-page loading state", () => {
    const html = renderToStaticMarkup(<WiredcioLoading />);

    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-dvh");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<span class="sr-only">Loading…</span>');
  });

  it("draws the mark through a mask so the artwork stays filled", () => {
    const html = renderToStaticMarkup(<WiredcioLoading />);

    expect(html).toContain("wiredcio-loading-logo-trace");
    expect(html).toContain('pathLength="1"');
    expect(html).toMatch(/<mask id="[^"]+"/);
  });

  it("allows containing layouts to override the full-page height", () => {
    const html = renderToStaticMarkup(<WiredcioLoading className="min-h-0" />);

    expect(html).toContain("min-h-0");
    expect(html).not.toContain("min-h-dvh");
  });
});
