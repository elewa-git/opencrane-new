# Exact member inventory inputs

Member access and departure reviews find group, assistant and grant history through
an index, then read each saved stream by its exact name. Empty revoked access stays
incomplete until permission receipts arrive. Reviews block completion above 100
groups or 500 distinct people. Ordinary chat messages leave the review unchanged.
Unrelated pending read receipts no longer cause a global history scan or make the
review unavailable because of their volume. Removal checks read small saved
positions and indexed history receipts within their access time limit.

After an upgrade, reviews stay incomplete until a full member inventory rebuild
finishes. New unrelated grants cannot hide missing older inputs. Interrupted first
replays also require a complete rebuild before removal is enabled.
