import assert from 'node:assert/strict';

export function assertNoBrowserDisclosure(secrets: readonly string[], body: string): void {
  for (const secret of secrets) {
    assert(!body.includes(secret), 'An API reply disclosed a key');
  }
}

type ArtifactReader = {
  readLocalValues: () => Promise<string>;
  readInstalledValues: () => Promise<string>;
  kube: (args: string[]) => Promise<string>;
};

export async function checkProviderArtifacts(reader: ArtifactReader,
  secrets: readonly string[], _qualification: boolean): Promise<void> {
  const values = await reader.readLocalValues();
  const manifests = await reader.kube(
    ['get', 'deployment,statefulset,cronjob,job,configmap', '-o', 'json']);
  const logs = await reader.kube(
    ['logs', '-l', 'app=server', '--all-containers=true', '--prefix=true', '--tail=-1']);
  for (const content of [values, manifests, logs]) {
    for (const secret of secrets) {
      assert(!content.includes(secret), 'A public artifact disclosed a key');
    }
  }
}
