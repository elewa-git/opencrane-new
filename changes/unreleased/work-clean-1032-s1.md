New imports between apps and from product source into `scripts/` now fail the
dependency check. The 15 existing violations are recorded in
`.dependency-cruiser-known-violations.json`; fixed entries must be removed and the
count cannot rise against the base commit. Product behaviour is unchanged.
