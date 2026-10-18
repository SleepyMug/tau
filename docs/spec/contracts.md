# Contracts

A **contract** is an API as it is published: an npm package of TypeScript declarations, which a
tau names, with a range of its versions (see [APIs](apis.md)), and a runtime implements (see
[Implementations](implementations.md)). Its package's name and version are its identity: an
implementation of `@sleepymug/tau-api-notes` at 1.2.0 does what that package declares, and its
documentation says, whoever wrote it and whatever tau it serves. It may be published on a
registry, such as npm's, or only by a backend that implements it, which gives it to the authors
of the taus it runs (see [Authoring](authoring.md)).

## The package

```
tau-api-notes/
├── package.json
├── index.d.ts        what programs import
└── tags.d.ts         a file index.d.ts imports
```

```json
{
  "name": "@sleepymug/tau-api-notes",
  "version": "1.2.0",
  "description": "A notebook of short notes, each with tags to find them by later.",
  "tau": { "contract": true },
  "type": "module",
  "types": "./index.d.ts"
}
```

`package.json` has, beside whatever else npm reads:
- `name`, the contract's name, an npm package's name, scoped or not;
- `version`, its version, as [Versions](#versions) has it;
- `description`, what it is, a string that is not blank, which runtimes may show the model;
- `tau`, `{ "contract": true }`, which says it is a contract;
- `type`, `module`, so that its declarations are an ES module's, as the agent's programs import it;
- `types`, `./index.d.ts`, so that an implementation's code imports it by name, as any package.

Its **declarations** are `index.d.ts` and the declaration files (`.d.ts`) it imports, at any depth.
What a runtime shows the agent of a contract, and what the `tau` command pulls of it, are only those
and `package.json`; anything else the package holds, such as tests an implementation should pass, is
its publisher's. The declarations may declare whatever such files can: functions, sync or async,
overloaded or generic; classes, constants, namespaces, interfaces and types. Beyond what TypeScript
asks of such files:
- **They type-check.** TypeScript 6.0 checks them with `strict` on, imports resolved as Node.js
  resolves them (`"module": "NodeNext"`), and the ES2022 library and the types of Node.js 24
  (`@types/node`) as the environment, since the agent's programs run on Node.js 24 or later. It must
  find no errors in them, and `index.d.ts` is a module, so that programs can import it.
- **They are self-contained.** They lie in the package's directory, and import one another by
  relative paths, such as `./tags.js`, and, beyond them, only Node.js's own modules, whose types
  are the environment's: no other package, and no other contract.
- **They are the whole contract.** What each function does, what it throws, what lasts and for how
  long, is said in their doc comments, in TSDoc, which programs, the agent, and implementers all
  read. Nothing else the package holds adds to it.

## Versions

A version is a SemVer 2.0.0 version, `MAJOR.MINOR.PATCH`, and maybe a prerelease after a `-`, as
`1.3.0-rc.1`, or build metadata after a `+`, which nothing compares. A version **serves** another,
the one a tau's range gives, `^1.2.0` giving 1.2.0 (see [APIs](apis.md)), when code written for
that one works with it:
- with a major of 1 or more, it has the same major, and a minor no less;
- with a major of 0, it has the same minor too;
- with a prerelease, it serves only itself, its build metadata aside.

The patch never matters, so a contract's publisher keeps to this:
- **A patch** changes no declaration, and nothing its documentation promises: a typo, a clearer
  sentence.
- **A minor** adds only what leaves code written for the version before working: new exports,
  optional parameters, optional members of what programs pass in, members of what they get back, a
  function taking more, or giving back less, than it did, and promises its documentation adds.
- **A major** may change anything. It is a new contract under the same name, which serves none of
  the earlier majors' taus.

## Contracts of tau's own

The tau API, `@sleepymug/tau-api` (see [The tau API](tau-api.md)), is a contract, which this
repository publishes in `contracts/tau-api/`: the run's files and args, runs of other taus, and
init's exit codes.
