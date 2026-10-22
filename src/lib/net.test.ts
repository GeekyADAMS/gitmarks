import { describe, expect, it } from "vitest";
import { isBlockedAddress, safeFetch } from "./net";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "not-an-ip",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "140.82.112.3", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe("safeFetch", () => {
  it("refuses internal targets before any request leaves", async () => {
    await expect(safeFetch("http://127.0.0.1:1/")).rejects.toThrow(/not a public address/);
    await expect(safeFetch("http://[::1]/")).rejects.toThrow(/not a public address/);
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /not a public address/,
    );
    await expect(safeFetch("http://localhost/")).rejects.toThrow(/not a public address/);
  });

  it("refuses other schemes", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});
