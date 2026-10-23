import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "@nats-io/transport-node";
import { promisify } from "node:util";

const exec = promisify(execFile);
let sharedCredentials: Promise<Map<string, Buffer>> | undefined;

async function generateSharedCredentials() {
  const directory = await mkdtemp(join(tmpdir(), 'nats-certificates-'));
  try {
    await certificates(directory);
    const credentials = new Map<string, Buffer>();
    const names = await readdir(directory);
    for (const name of names) {
      const contents = await readFile(join(directory, name));
      credentials.set(name, contents);
    }
    return credentials;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Copy reusable credentials into files that only this fixture can change or remove. */
export async function sharedCertificates(directory: string) {
  // Share the pending generation too, so concurrent fixtures only run OpenSSL once.
  sharedCredentials ??= generateSharedCredentials();
  const credentials = await sharedCredentials;
  for (const [name, contents] of credentials) {
    await writeFile(join(directory, name), contents, { mode: 0o600 });
  }
}

/** A fresh CA and short-lived credentials, kept only in the disposable fixture directory. */
export async function certificates(directory: string, days = 1) {
  const openssl = (...args: string[]) => exec("openssl", args, { cwd: directory });
  await openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", String(days), "-subj", "/CN=test-ca");
  for (const identity of ["server", "command", "projection", "dispatcher", "computer", "gateway", "unknown"]) {
    const user = nkeys.createUser();
    await writeFile(`${directory}/${identity}.seed`, user.getSeed(), { mode: 0o600 });
    await writeFile(`${directory}/${identity}.pub`, user.getPublicKey());
    user.clear();
    await issueCertificate(directory, identity, `/CN=${identity}`, identity === "server"
      ? "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n"
      : "extendedKeyUsage=clientAuth\n", days);
  }
}

export async function issueCertificate(directory: string, name: string, subject: string,
  extensions = "extendedKeyUsage=clientAuth\n", days = 1) {
  const openssl = (...args: string[]) => exec("openssl", args, { cwd: directory });
  await openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", subject);
  await writeFile(`${directory}/${name}.ext`, extensions);
  await openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", `${name}.crt`, "-days", String(days), "-extfile", `${name}.ext`);
}
