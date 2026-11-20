export type PackageReview = {
  requiredSecrets: string[];
  chartVersion: string;
  images: Record<string, string>;
};
