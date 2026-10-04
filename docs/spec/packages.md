# Packages

A tau may hold packages of its own in `node_modules/`, as Node.js finds them, built on its APIs:
code that its author, or a tool that tunes agents, puts between the APIs and the model, such as a
function that makes several calls in one, so that the model can do more with less. `exposes` names
those the agent's programs import (see [Metadata](metadata.md)); a package may import the APIs, and
anything else in the tau's `node_modules/`, whether `exposes` names it or not.

When `exposes` names a package of the tau's own, a runtime reads `node_modules/` (see
[Directory](directory.md)), which holds no `@api` scope, nor does any `node_modules/` inside it,
since that would hide the runtime's implementations (see [Implementations](implementations.md)).
Each package `exposes` names keeps to this:
- **It is JavaScript, with declarations.** It is at `node_modules/<name>`, runs on Node.js 24 or
  later, and has TypeScript declarations of what programs import of it.
- **It type-checks.** Its declarations, and what they import, are checked as API files are (see
  [APIs](apis.md)), with `@api/<name>` typed by `api/<name>/index.d.ts`, so that it is built on
  the APIs as the tau declares them, not on an implementation. TypeScript must find no errors in
  the package's own files, and every import in the files it reaches resolves. The types of the
  packages it uses are taken as they are.
- **It is self-contained.** Each import, in its declarations and its JavaScript, resolves to a
  file in the tau, to Node.js's own modules, or, as `@api/<name>`, to an API the tau declares.
- **Documentation:** the first doc comment of its declarations, if it has `@packageDocumentation`,
  or else its `package.json`'s `description`, describes it.
