# Runtimes

How what a tau exposes, and its skills, reach the model is up to the runtime. pi-run, for example,
gives the model a TypeScript `execute` tool, whose programs import each API as `@api/<name>`,
typed by its declarations. Like an API, `exposes` is an abstraction boundary, not a security one:
a runtime presents what it names, and may let programs import more, such as an API the tau does
not expose.
