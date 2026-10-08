# Development

`@sleepymug/tau-dev` is for those who make taus and contracts, where the runtime's library checks
only what a run needs (see [Library](library.md)). Its command, `tau`, checks a tau as its author
makes it, copies contracts into it, and checks contracts as their publishers make them. Each
command that checks exits 1, listing every problem it finds, and the package exports each command
as a function of the same name, `checkTau`, `addContract`, `updateContracts`, `checkContract` and
`diffContracts`, which throws instead.

```sh
tau add notes @sleepymug/tau-api-notes        # copy the newest version into api/notes/
tau add tau @sleepymug/tau-api@0.1            # or one that a range picks
tau check                                     # check the tau in this directory
tau update                                    # copy in the newest version that serves each API

tau contract check contracts/notes            # check a contract before publishing it
tau contract diff @sleepymug/tau-api-notes contracts/notes   # and its version against the last
```

- **`tau check [dir]`** checks the tau at `dir`, by default the working directory: what `loadTau`
  checks, and what it leaves to the author: each API's copy, as [Contracts](contracts.md) asks of
  a contract's declarations, holding them all, and no other declaration file; and each package
  of the tau's own that `exposes` names, as [Packages](packages.md) asks.
- **`tau add <alias> <package>`** copies a contract into the tau in the working directory, as
  `api/<alias>/` (see [APIs](apis.md)): its `package.json` and its declarations, replacing what is
  there. `<package>` is a package as npm names it: a name, with a version or a range, as
  `@sleepymug/tau-api-notes@^1.2`, a directory, or a tarball. It checks the contract as
  `tau contract check` does first, and refuses a package that is not a contract, or one the tau
  holds under another alias.
- **`tau update [alias…]`** copies into the tau in the working directory, for each of its APIs or
  those named, the newest version of its contract that serves the one it holds (see
  [Contracts](contracts.md#versions)), as `tau add` does.
- **`tau contract check [dir]`** checks the contract whose package is at `dir`, by default the
  working directory, as [Contracts](contracts.md) has it.
- **`tau contract diff <old> <new>`** checks that the contract `<new>`, a package as `tau add` takes
  it, may follow `<old>`, as their versions say: that it has the same name, a greater version, and,
  when its version serves `<old>`'s, that TypeScript finds the type of the module `<new>` declares
  assignable to `<old>`'s, so that each value `<old>` exports, `<new>` exports too, of a type that
  fits wherever code written for `<old>` uses it. It checks what values a contract exports, not
  what its documentation promises, nor whether a patch changes nothing.

`tau add`, `tau update` and `tau contract diff` fetch a package as npm does, from the registry,
with npm's own fetcher, `pacote`.
The checks use TypeScript 6.0, against Node.js 24's types, both of which the package pins:
`tau check` takes about 0.4 s for a tau, and as long again when it exposes packages of its own.
