# APIs

`apis`, in `tau.json` (see [Metadata](metadata.md)), names the APIs the tau's code calls, each a
contract (see [Contracts](contracts.md)), from the contract's name to a **range**, the versions of
it the tau works with:

```json
"apis": {
  "@acme/travel": "^1.2.0",
  "@sleepymug/tau-api": "^0.1.0"
}
```

Each name is an npm package's, scoped or not, as a contract's is. A range is `^` and a version,
and takes the versions that serve that one (see [Contracts](contracts.md#versions)): the version
the tau's author wrote against, or the oldest the tau works with.

The agent's programs, and the packages of the tau's own, import an API by its contract's name,
`@acme/travel`, and get the runtime's implementation (see [Implementations](implementations.md)).
The tau holds neither the contract's declarations nor its implementation: a runtime gives both,
by the contract's name and the range alone. So a tau can call a contract that no registry has,
which only its backend publishes; where its author found it is the `tau` command's (see
[Authoring](authoring.md)), and no part of the tau.

- **No package manager sees an API.** As a VS Code extension imports `vscode`, which its
  `engines` names and no dependency of its lists, a tau names its APIs only in `apis`, and a
  package of its own only in its `package.json`'s `tau.apis` (see [Packages](packages.md)), never
  in `dependencies` or `peerDependencies`, which a package manager would install, from a
  registry where a contract is declarations with nothing to run, or, published by a backend
  alone, is missing, or is another package by the same name.
- **Nothing in the tau shadows an API.** No `node_modules/` in the tau holds a package, or a
  symlink, named as one of its APIs, since Node.js would find it before the runtime's
  implementation (see [Implementations](implementations.md)).
