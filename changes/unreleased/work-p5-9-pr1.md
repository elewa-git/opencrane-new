- Event recovery checks now restore a pre-upgrade event copy after an interrupted
  handler subscription change and compare event order, positions and rebuilt membership
  tables, with zero reaction calls. Full package upgrade recovery remains unqualified.
