import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { nkeys } from "@nats-io/transport-node";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A fresh CA and one-day credentials, kept only in the disposable fixture directory. */
export async function certificates(directory: string) {
  const openssl = (...args: string[]) => exec("openssl", args, { cwd: directory });
  await openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=test-ca");
  for (const identity of ["server", "command", "projection", "dispatcher", "computer", "gateway", "unknown"]) {
    const user = nkeys.createUser();
    await writeFile(`${directory}/${identity}.seed`, user.getSeed(), { mode: 0o600 });
    await writeFile(`${directory}/${identity}.pub`, user.getPublicKey());
    user.clear();
    await issueCertificate(directory, identity, `/CN=${identity}`, identity === "server"
      ? "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n"
      : "extendedKeyUsage=clientAuth\n");
  }
}

export async function issueCertificate(directory: string, name: string, subject: string,
  extensions = "extendedKeyUsage=clientAuth\n") {
  const openssl = (...args: string[]) => exec("openssl", args, { cwd: directory });
  await openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", subject);
  await writeFile(`${directory}/${name}.ext`, extensions);
  await openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", `${name}.ext`);
}
