# Runtimes

The agent runs its programs with `node`, Node.js 24 or later: JavaScript, or TypeScript that
Node.js runs as is, stripping its types. Wherever the agent puts a program, it imports by name what
`exposes` lists (see [Metadata](metadata.md)), and the runtime makes these resolve there (see
[Implementations](implementations.md)).

How what a tau exposes, and its skills, reach the model is up to the runtime, such as where it
tells the agent to read their declarations. Like an API, `exposes` is an abstraction boundary, not
a security one: a runtime presents what it names, and may let programs import more, such as an API
the tau does not expose.
