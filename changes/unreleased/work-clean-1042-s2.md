Server membership, group, provider and integration-access tests now save fixture
events through the shared builder, preserving their identifiers, actors and times.
The builder accepts explicit principal, time and commandId options while refusing
unsupported envelope fields at the type boundary.
