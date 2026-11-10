# Runtimes

The agent runs its programs with `node`, Node.js 24 or later: JavaScript, or TypeScript that Node.js
runs as is, stripping its types. A runtime gives the agent a **program directory**: a directory the
agent may write, other than the tau's own, which may be read-only, whose `node_modules/` holds the
tau's packages (see [Packages](packages.md)), a copy of the tau's `node_modules/` or a link to it.
Node.js looks for a package in every directory above the file that imports it, so a program the
agent writes anywhere below the program directory imports the tau's packages by name, as the tau's
own code does, and the commands they declare, in `node_modules/.bin/`, are on the agent's `PATH`.
Where the program directory is, and how the agent is told, are the runtime's.

How what a tau exposes, and its skills, reach the model is up to the runtime, such as where it tells
the agent to read a package's declarations. `exposes` is an abstraction boundary, not a security
one: a runtime presents what it names, and programs import every package of the tau's.

What else the agent's programs reach, such as commands the runtime puts on the `PATH`, and the
modules it gives them, is the runtime's to say, and to present to the model.
