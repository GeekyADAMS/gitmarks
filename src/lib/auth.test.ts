import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBearer,
  checkPassword,
  createSession,
  deviceKey,
  isThrottled,
  readDeviceKey,
  readSession,
  recordFailure,
  seal,
  secret,
  unseal,
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
    const token = createSession({}, now)!;
    expect(readSession(token, now)).toBeTruthy();
    const [body, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const extended = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 1 })).toString("base64url");
    expect(readSession(`${extended}.${signature}`, now)).toBeNull();
    expect(readSession(token, now + 31 * 24 * 60 * 60 * 1000)).toBeNull();
    process.env.GITMARKS_SECRET = `${SECRET}-rotated`;
    expect(readSession(token, now)).toBeNull();
  });

  it("carries a hosted owner's installation and repo, and nobody can swap them", () => {
    const token = createSession({ i: 1, r: "alice/bookmarks", u: 7 })!;
    expect(readSession(token)).toMatchObject({ i: 1, r: "alice/bookmarks", u: 7 });
    const [, signature] = token.split(".");
    const swapped = Buffer.from(JSON.stringify({ i: 2, r: "bob/bookmarks", u: 8, exp: 9e15 })).toString(
      "base64url",
    );
    expect(readSession(`${swapped}.${signature}`)).toBeNull();
  });

  it("will not accept a token minted for one job as another", () => {
    const state = seal("state", { n: "x" })!;
    expect(unseal("state", state)).toEqual({ n: "x" });
    expect(readSession(state)).toBeNull();
    expect(readDeviceKey(`Bearer gm_${createSession()}`)).toBeNull();
  });

  it("gives one device key per owner, which only works as a bearer token", () => {
    const key = deviceKey({ i: 1, r: "alice/bookmarks", u: 7 })!;
    expect(key).toMatch(/^gm_/);
    expect(deviceKey({ i: 1, r: "alice/bookmarks", u: 7 })).toBe(key);
    expect(readDeviceKey(`Bearer ${key}`)).toEqual({ i: 1, r: "alice/bookmarks", u: 7 });
    expect(readDeviceKey(key)).toBeNull();
    expect(readSession(key.slice(3))).toBeNull();
    // Self-hosted: one owner, so one key, and it does not reveal the secret.
    expect(deviceKey({})).not.toContain(SECRET);
    expect(readDeviceKey(`Bearer ${deviceKey({})}`)).toEqual({});
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
