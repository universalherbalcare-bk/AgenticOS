/**
 * Mints a throwaway self-signed X.509 certificate at test time, with nothing but node:crypto.
 *
 * Why: two fixtures used to carry genuine full-length RSA private keys checked into the tree
 * (client.watchdog.test.ts, push-apns.test.ts). They granted nothing, but they were real key
 * material and needed a secret-scanner allowlist entry each. Node can generate keys but has
 * no API to issue a certificate, so this file encodes the small DER/ASN.1 subset a TLS test
 * server needs: v3 certificate, sha256WithRSAEncryption, CN + subjectAltName(dNSName/IP),
 * basicConstraints CA:TRUE (so the cert can be its own trust root when a test wants that).
 *
 * The result is verified on the way out (`X509Certificate.checkPrivateKey`), so a broken
 * encoder fails loudly at fixture time instead of as a confusing TLS handshake error.
 */
import { createSign, generateKeyPairSync, X509Certificate, createPrivateKey } from "node:crypto";

export type SelfSignedCert = {
  /** PKCS#8 PEM private key. */
  key: string;
  /** X.509 PEM certificate. */
  cert: string;
  /** Lower-case hex SHA-256 fingerprint of the DER certificate, as tls peer fingerprints report it. */
  fingerprint256: string;
};

export type SelfSignedCertOptions = {
  /** Subject/issuer common name. Default "localhost". */
  commonName?: string;
  /** DNS subjectAltNames. Default [commonName]. */
  dnsNames?: string[];
  /** IPv4 subjectAltNames. Default ["127.0.0.1"]. */
  ipAddresses?: string[];
  /** RSA modulus length. Default 2048. */
  modulusLength?: number;
  /** Validity window in days around now. Default 1. */
  validDays?: number;
};

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_UTC_TIME = 0x17;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

function encodeLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(TAG_SET, Buffer.concat(parts));
}

function integer(value: Buffer | number): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    const out: number[] = [];
    let remaining = value;
    do {
      out.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    } while (remaining > 0);
    bytes = Buffer.from(out);
  } else {
    bytes = value;
  }
  // INTEGER is two's complement: a leading high bit needs a 0x00 pad to stay positive.
  if (bytes.length === 0 || (bytes[0]! & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return tlv(TAG_INTEGER, bytes);
}

function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((part) => Number.parseInt(part, 10));
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0)) {
    throw new Error(`invalid OID: ${dotted}`);
  }
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(TAG_OID, Buffer.from(bytes));
}

function utf8String(value: string): Buffer {
  return tlv(TAG_UTF8_STRING, Buffer.from(value, "utf8"));
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(TAG_UTC_TIME, Buffer.from(text, "ascii"));
}

function bitString(content: Buffer): Buffer {
  return tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([0x00]), content]));
}

function octetString(content: Buffer): Buffer {
  return tlv(TAG_OCTET_STRING, content);
}

function explicitTag(index: number, content: Buffer): Buffer {
  return tlv(0xa0 | index, content);
}

function implicitTag(index: number, content: Buffer): Buffer {
  return tlv(0x80 | index, content);
}

const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_COMMON_NAME = "2.5.4.3";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const NULL_PARAMS = tlv(TAG_NULL, Buffer.alloc(0));

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));
}

function ipv4Octets(address: string): Buffer {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error(`self-signed-cert: only IPv4 addresses are supported, got ${address}`);
  }
  return Buffer.from(parts);
}

function extensions(dnsNames: string[], ipAddresses: string[]): Buffer {
  const generalNames = sequence(
    ...dnsNames.map((dns) => implicitTag(2, Buffer.from(dns, "ascii"))),
    ...ipAddresses.map((ip) => implicitTag(7, ipv4Octets(ip))),
  );
  const san = sequence(oid(OID_SUBJECT_ALT_NAME), octetString(generalNames));
  const basicConstraints = sequence(
    oid(OID_BASIC_CONSTRAINTS),
    Buffer.from([0x01, 0x01, 0xff]), // critical BOOLEAN TRUE
    octetString(sequence(Buffer.from([0x01, 0x01, 0xff]))), // cA TRUE
  );
  return explicitTag(3, sequence(san, basicConstraints));
}

function pem(label: string, der: Buffer): string {
  const body = der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Generates a fresh RSA key pair and a self-signed certificate for it. */
export function createSelfSignedCert(options: SelfSignedCertOptions = {}): SelfSignedCert {
  const commonName = options.commonName ?? "localhost";
  const dnsNames = options.dnsNames ?? [commonName];
  const ipAddresses = options.ipAddresses ?? ["127.0.0.1"];
  const validDays = options.validDays ?? 1;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: options.modulusLength ?? 2048,
  });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const now = Date.now();
  const notBefore = new Date(now - validDays * 86_400_000);
  const notAfter = new Date(now + validDays * 86_400_000);
  const serial = Buffer.from(String(now).padStart(16, "0").slice(-16), "utf8");
  const signatureAlgorithm = sequence(oid(OID_SHA256_WITH_RSA), NULL_PARAMS);

  const tbs = sequence(
    explicitTag(0, integer(2)), // v3
    integer(serial),
    signatureAlgorithm,
    name(commonName),
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name(commonName),
    spki,
    extensions(dnsNames, ipAddresses),
  );
  const signature = createSign("sha256").update(tbs).sign(privateKey);
  const certificate = sequence(tbs, signatureAlgorithm, bitString(signature));
  const certPem = pem("CERTIFICATE", certificate);

  const parsed = new X509Certificate(certPem);
  if (!parsed.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new Error("self-signed-cert: generated certificate does not match its key");
  }
  return {
    key: keyPem,
    cert: certPem,
    fingerprint256: parsed.fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}
