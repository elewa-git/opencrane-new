import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nkeys } from "@nats-io/transport-node";
import { promisify } from "node:util";

const exec = promisify(execFile);
async function openssl(...args: string[]) {
  await exec("openssl", args);
}

/** Create a fresh CA and short-lived credentials in the caller's private directory. */
export async function certificates(directory: string, days = 1) {
  const certificateDirectory = resolve(directory);
  await openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", join(certificateDirectory, "ca.key"),
    "-out", join(certificateDirectory, "ca.crt"),
    "-days", String(days), "-subj", "/CN=test-ca");
  for (const identity of ["server", "command", "projection", "dispatcher", "computer", "gateway", "unknown"]) {
    const user = nkeys.createUser();
    await writeFile(join(certificateDirectory, `${identity}.seed`), user.getSeed(),
      { mode: 0o600 });
    await writeFile(join(certificateDirectory, `${identity}.pub`), user.getPublicKey());
    user.clear();
    await issueCertificate(certificateDirectory, identity, `/CN=${identity}`, identity === "server"
      ? "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n"
      : "extendedKeyUsage=clientAuth\n", days);
  }
}

export async function issueCertificate(directory: string, name: string, subject: string,
  extensions = "extendedKeyUsage=clientAuth\n", days = 1) {
  const certificateDirectory = resolve(directory);
  await openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", join(certificateDirectory, `${name}.key`),
    "-out", join(certificateDirectory, `${name}.csr`), "-subj", subject);
  await writeFile(join(certificateDirectory, `${name}.ext`), extensions);
  await openssl("x509", "-req", "-in", join(certificateDirectory, `${name}.csr`),
    "-CA", join(certificateDirectory, "ca.crt"),
    "-CAkey", join(certificateDirectory, "ca.key"),
    "-CAcreateserial", "-out", join(certificateDirectory, `${name}.crt`),
    "-days", String(days), "-extfile", join(certificateDirectory, `${name}.ext`));
}
