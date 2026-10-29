Routine Stop tests now compare absolute write deadlines, avoiding false failures from
fractional clock rounding. Slow-history checks still require a saved owner Stop and
verify that it prevents further routine preparation.
