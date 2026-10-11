# Exact member inventory inputs

Member access and departure reviews find group, assistant and grant history through
an index, then read each saved stream by its exact name. Empty revoked access stays
incomplete until permission receipts arrive. Reviews block completion above 100
groups or 500 distinct people. Projected chat messages leave the review unchanged.

After an upgrade, reviews stay incomplete until a full member inventory rebuild
finishes. New unrelated grants cannot hide missing older inputs. Interrupted first
replays also require a complete rebuild before removal is enabled.
