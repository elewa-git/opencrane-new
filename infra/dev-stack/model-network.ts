import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const chain = 'OPENCRANE-MODELS';
const iptables = (binary: string, ...args: string[]) => exec('sudo', ['-n', binary, '-w', ...args]);

// agentgateway 1.5 has no listen-address option. Restrict its one host port before launching it.
export async function modelFirewall(enabled: boolean) {
  const networks = JSON.parse((await exec('docker', ['network', 'inspect', 'k3d-ocn'])).stdout) as Array<{ Id: string }>;
  const bridge = `br-${networks[0]!.Id.slice(0, 12)}`;
  for (const binary of ['iptables', 'ip6tables']) {
    const exists = await iptables(binary, '-S', chain).then(() => true, () => false);
    if (!enabled) {
      if (!exists) continue;
      await iptables(binary, '-D', 'INPUT', '-p', 'tcp', '--dport', '43000', '-j', chain);
      await iptables(binary, '-F', chain);
      await iptables(binary, '-X', chain);
      continue;
    }
    if (!exists) {
      await iptables(binary, '-N', chain);
      for (const device of ['lo', 'tailscale0', bridge]) await iptables(binary, '-A', chain, '-i', device, '-j', 'ACCEPT');
      await iptables(binary, '-A', chain, '-j', 'DROP');
      await iptables(binary, '-I', 'INPUT', '1', '-p', 'tcp', '--dport', '43000', '-j', chain);
    }
    await iptables(binary, '-C', 'INPUT', '-p', 'tcp', '--dport', '43000', '-j', chain);
    await iptables(binary, '-C', chain, '-j', 'DROP');
  }
}
