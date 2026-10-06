# Runtimes

The agent runs its programs with `node`, Node.js 24 or later: JavaScript, or TypeScript that
Node.js runs as is, stripping its types. A program's imports resolve from the tau's directory, as
the tau's own code does: a package of the tau's own from its `node_modules/` (see
[Packages](packages.md)), and an API from the runtime (see [Implementations](implementations.md)),
so a program imports by name what `exposes` lists (see [Metadata](metadata.md)). How the agent
runs a program there is the runtime's, such as with `node -` in the tau's directory, which reads
the program from stdin and resolves its imports from the working directory.

How what a tau exposes, and its skills, reach the model is up to the runtime, such as where it
tells the agent to read their declarations. Like an API, `exposes` is an abstraction boundary, not
a security one: a runtime presents what it names, and may let programs import more, such as an API
the tau does not expose, or a package of the tau's own.
