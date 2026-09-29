# Security

## The bridge is remote code execution, on purpose

The bridge this tooling injects into Gang Garrison 2 runs any GML it is sent.
GML can read and write files and start programs, so a connection to the bridge
is full control of the account running the game. That is what makes it useful
for development, and it is safe only while all of these hold:

- the bridge listens only in a game started with `-agent`;
- it accepts connections from loopback (`127.0.0.1`, `::1`) and drops the rest
  (`payload/Scripts/AgentBridge/agentBridgeStep.gml`);
- it is injected into the game's source tree for a build and removed straight
  afterwards, so it is never committed to the game and never in a release built
  from it.

Anyone on the same machine can still connect. Do not run an `-agent` game on a
shared machine you do not trust, and never distribute an executable this
tooling built.

## Reporting a vulnerability

A way around any of the three guards above - the bridge reachable from another
machine, listening without `-agent`, or surviving into a checkout after a build -
is a vulnerability. Please report it privately through GitHub's
[private vulnerability reporting](https://github.com/kylelmoy/gg2-agent/security/advisories/new)
rather than in a public issue.

Gang Garrison 2 itself is a separate project; report problems in the game to
[its repository](https://github.com/Gang-Garrison-2/Gang-Garrison-2).
