import { describe, expect, it } from "vitest";
import { autoCheckDelay, decideUpdate, formatBytes, formatProgress, progressFraction } from "./updates";

describe("autoCheckDelay", () => {
  const start = 1_000_000;
  it("first check 15 s after startup", () => {
    expect(autoCheckDelay(start, start, null, true, "idle")).toBe(15_000);
    expect(autoCheckDelay(start + 20_000, start, null, true, "idle")).toBe(0);
  });
  it("then every 6 hours after the previous automatic check", () => {
    const last = start + 15_000;
    expect(autoCheckDelay(last + 1000, start, last, true, "upToDate")).toBe(6 * 3600 * 1000 - 1000);
  });
  it("none when the preference is off or updates are disabled", () => {
    expect(autoCheckDelay(start, start, null, false, "idle")).toBeNull();
    expect(autoCheckDelay(start, start, null, true, "disabled")).toBeNull();
  });
  it("honours shortened timings", () => {
    expect(autoCheckDelay(start, start, null, true, null, { first: 100, every: 500 })).toBe(100);
  });
});

describe("progress", () => {
  it("formats bytes in Italian", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(18 * 1024 * 1024)).toBe("18,0 MB");
  });
  it("formats progress with and without a total", () => {
    expect(formatProgress(4.5 * 1024 * 1024, 18 * 1024 * 1024)).toBe("4,5 MB di 18,0 MB (25%)");
    expect(formatProgress(2048, null)).toBe("2,0 KB scaricati");
    expect(progressFraction(10, 0)).toBeNull();
    expect(progressFraction(30, 20)).toBe(1);
  });
});

describe("decideUpdate", () => {
  const o = (dirty = 0, armed = false, justChecked = false) => ({ dirty, armed, justChecked });
  it("does nothing while busy, and refuses in a development build", () => {
    for (const p of ["checking", "downloading", "installing"] as const) expect(decideUpdate(p, o())).toBe("busy");
    expect(decideUpdate("disabled", o())).toBe("disabled");
  });
  it("checks first when no newer version is known", () => {
    for (const p of ["idle", "upToDate", "error"] as const) expect(decideUpdate(p, o())).toBe("check");
  });
  it("after the check: install, latest or failed", () => {
    expect(decideUpdate("available", o(0, false, true))).toBe("install");
    expect(decideUpdate("upToDate", o(0, false, true))).toBe("latest");
    expect(decideUpdate("error", o(0, false, true))).toBe("failed");
  });
  it("asks to repeat with unsaved buffers, installs when repeated", () => {
    expect(decideUpdate("available", o(2))).toBe("confirm");
    expect(decideUpdate("available", o(2, true))).toBe("install");
  });
});
