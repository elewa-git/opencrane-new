export type PublicPackageValues = {
  exposure?: {
    public?: { enabled: boolean; host: string; tlsSecret: string };
  };
};
export function checkExposure(values: PublicPackageValues): void;
export function checkPublicSettings(values: PublicPackageValues,
  settings: Record<string, string>): void;
export function readPublicSettings(values: PublicPackageValues): Record<string, string>;
