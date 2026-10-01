import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A fresh CA and one-day credentials, kept only in the disposable fixture directory. */
export async function certificates(directory: string) {
  const openssl = (...args: string[]) => exec("openssl", args, { cwd: directory });
  await openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=test-ca");
  for (const identity of ["server", "command", "projection", "dispatcher", "computer", "gateway", "unknown"]) {
    await openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-keyout", `${identity}.key`, "-out", `${identity}.csr`, "-subj", `/CN=${identity}`);
    await writeFile(`${directory}/${identity}.ext`, identity === "server"
      ? "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n"
      : "extendedKeyUsage=clientAuth\n");
    await openssl("x509", "-req", "-in", `${identity}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-out", `${identity}.crt`, "-days", "1", "-extfile", `${identity}.ext`);
  }
}
