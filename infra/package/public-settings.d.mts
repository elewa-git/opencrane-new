export type PublicPackageValues = {
  exposure?: {
    ingress: boolean;
    loadBalancer: boolean;
    funnel: boolean;
    public?: { enabled: boolean; host: string; tlsSecret: string };
  };
};
export function checkPublicSettings(values: PublicPackageValues,
  settings: Record<string, string>): void;
export function readPublicSettings(values: PublicPackageValues): Record<string, string>;
