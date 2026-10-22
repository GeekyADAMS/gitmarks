import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBearer,
  checkPassword,
  checkSession,
  createSession,
  isThrottled,
  recordFailure,
  secret,
} from "./auth";

const SECRET = "a-long-random-secret-for-tests-0123456789";

describe("the one secret", () => {
  beforeEach(() => {
    process.env.GITMARKS_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.GITMARKS_SECRET;
  });

  it("refuses to run on a short secret, so nothing can open", () => {
    process.env.GITMARKS_SECRET = "short";
    expect(secret()).toBeUndefined();
    expect(checkPassword("short")).toBe(false);
    expect(checkBearer("Bearer short")).toBe(false);
    expect(createSession()).toBeNull();
  });

  it("is the password, tolerating a pasted trailing newline", () => {
    expect(checkPassword(`${SECRET}\n`)).toBe(true);
    expect(checkPassword(SECRET.slice(0, -1))).toBe(false);
  });

  it("is the bearer token, and only in the exact header form", () => {
    expect(checkBearer(`Bearer ${SECRET}`)).toBe(true);
    expect(checkBearer(SECRET)).toBe(false);
    expect(checkBearer(null)).toBe(false);
  });

  it("signs sessions that cannot be forged, extended, or outlive their month", () => {
    const now = Date.now();
    const token = createSession(now)!;
    expect(checkSession(token, now)).toBe(true);
    const [expires, signature] = token.split(".");
    expect(checkSession(`${Number(expires) + 1}.${signature}`, now)).toBe(false);
    expect(checkSession(token, now + 31 * 24 * 60 * 60 * 1000)).toBe(false);
    process.env.GITMARKS_SECRET = `${SECRET}-rotated`;
    expect(checkSession(token, now)).toBe(false);
  });
});

describe("login throttle", () => {
  it("locks after ten failures and lets go after fifteen minutes", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) recordFailure("ip", now);
    expect(isThrottled("ip", now)).toBe(true);
    expect(isThrottled("ip", now + 16 * 60 * 1000)).toBe(false);
  });
});
