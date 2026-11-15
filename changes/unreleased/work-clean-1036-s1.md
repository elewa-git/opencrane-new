Lint now refuses new whole-stream reads in server, operations and library source,
using the TypeScript parser. Existing reads are recorded separately from the three
rebuild paths; both sets of counts can only shrink. Product behaviour is unchanged.
