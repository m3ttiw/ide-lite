import { describe, expect, it } from "vitest";
import { relativeDate } from "./reldate";

const now = Date.UTC(2026, 10, 12, 12, 0, 0);
const ago = (sec: number) => relativeDate(now / 1000 - sec, now);

describe("relativeDate", () => {
  it("formats in Italian", () => {
    expect(ago(5)).toBe("adesso");
    expect(ago(-30)).toBe("adesso");
    expect(ago(60)).toBe("1 minuto fa");
    expect(ago(59 * 60)).toBe("59 minuti fa");
    expect(ago(3600)).toBe("1 ora fa");
    expect(ago(2 * 3600 + 120)).toBe("2 ore fa");
    expect(ago(23 * 3600)).toBe("23 ore fa");
    expect(ago(30 * 3600)).toBe("ieri");
    expect(ago(3 * 86400)).toBe("3 giorni fa");
    expect(ago(7 * 86400)).toBe("1 settimana fa");
    expect(ago(20 * 86400)).toBe("2 settimane fa");
    expect(ago(31 * 86400)).toBe("1 mese fa");
    expect(ago(200 * 86400)).toBe("6 mesi fa");
    expect(ago(365 * 86400)).toBe("1 anno fa");
    expect(ago(3 * 365 * 86400)).toBe("3 anni fa");
  });
});
