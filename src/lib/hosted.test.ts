import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt, safePath, type App } from "./hosted";

describe("the GitHub App's JWT", () => {
  it("is RS256, issued by the client ID, backdated a minute and short-lived", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app: App = {
      clientId: "Iv1.test",
      clientSecret: "x",
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      slug: "gitmarks",
    };
    const now = 1_700_000_000_000;
    const [header, payload, signature] = appJwt(app, now).split(".");
    const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "Iv1.test" });
    expect(
      verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });
});

describe("where a sign-in may return to", () => {
  it("is a path on this site and nothing else", () => {
    expect(safePath("/share?url=https%3A%2F%2Fx.com")).toBe("/share?url=https%3A%2F%2Fx.com");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "evil", "", null]) {
      expect(safePath(bad)).toBe("/");
    }
  });
});
