import { createPrivateKey, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { connect } from "node:tls";
import { describe, expect, it } from "vitest";
import { createSelfSignedCert } from "./self-signed-cert.js";

describe("createSelfSignedCert", () => {
  it("mints a certificate Node parses, that matches its key, with the requested names", () => {
    const { key, cert, fingerprint256 } = createSelfSignedCert({
      commonName: "api.sandbox.push.apple.com",
      dnsNames: ["api.sandbox.push.apple.com", "api.push.apple.com"],
    });
    const parsed = new X509Certificate(cert);
    expect(parsed.subject).toContain("CN=api.sandbox.push.apple.com");
    expect(parsed.issuer).toBe(parsed.subject);
    expect(parsed.subjectAltName).toContain("DNS:api.sandbox.push.apple.com");
    expect(parsed.subjectAltName).toContain("DNS:api.push.apple.com");
    expect(parsed.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(parsed.ca).toBe(true);
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(fingerprint256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(parsed.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(Date.now());
    expect(key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(key).not.toBe(createSelfSignedCert().key);
  });

  it("serves TLS: a client trusting the cert as CA completes the handshake and sees the fingerprint", async () => {
    const { key, cert, fingerprint256 } = createSelfSignedCert();
    const server = createServer({ key, cert }, (_req, res) => {
      res.end("ok");
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("no address"));
          return;
        }
        resolve(address.port);
      });
    });
    try {
      const seen = await new Promise<string>((resolve, reject) => {
        const socket = connect(
          { host: "127.0.0.1", port, ca: cert, servername: "localhost" },
          () => {
            const peer = socket.getPeerCertificate();
            const fingerprint = peer.fingerprint256.replaceAll(":", "").toLowerCase();
            socket.end();
            resolve(fingerprint);
          },
        );
        socket.once("error", reject);
      });
      expect(seen).toBe(fingerprint256);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
