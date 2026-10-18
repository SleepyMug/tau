# Packages

A tau may hold packages of its own in `node_modules/`, as Node.js finds them, built on its APIs:
code that its author, or a tool that tunes agents, puts between the APIs and the model, such as a
function that makes several calls in one, so that the model can do more with less. `exposes` names
those the agent's programs import (see [Metadata](metadata.md)); a package may import the APIs, and
anything else in the tau's `node_modules/`, whether `exposes` names it or not.

When `exposes` names a package of the tau's own, a runtime reads `node_modules/` (see
[Directory](directory.md)), which, like any `node_modules/` inside it, holds no package named as
an API, since that would hide the runtime's implementation (see [APIs](apis.md)). Each package
`exposes` names keeps to this:
- **It is JavaScript, with declarations.** It is at `node_modules/<name>`, runs on Node.js 24 or
  later, and has TypeScript declarations of what programs import of it.
- **It type-checks.** Its declarations, and what they import, are checked as a contract's are (see
  [Contracts](contracts.md)), with each API typed by its contract's declarations, at the version the
  tau's range gives, such as the `tau` command keeps (see [Authoring](authoring.md)), so that it is
  built on the APIs, not on an implementation. TypeScript must find no
  errors in the package's own files, and every import in the files it reaches resolves. The types
  of the packages it uses are taken as they are.
- **It is self-contained.** Each import, in its declarations and its JavaScript, resolves to a
  file in the tau, to Node.js's own modules, or to an API of the tau, by its contract's name, left
  as it is by whatever built the package.
- **It names its APIs.** Its `package.json` names each API it imports in `tau.apis`, from the
  contract's name to a range, as `apis` in `tau.json` does (see [APIs](apis.md)), and in none of
  its dependencies; the tau names each too, at a range whose version serves the package's, so the
  tau works with no older a contract than the package needs.

  ```json
  { "name": "trip-search", "version": "2.0.0", "tau": { "apis": { "@acme/travel": "^1.1.0" } } }
  ```
- **Documentation:** its `package.json`'s `description`, if it has one, describes it.
