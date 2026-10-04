# APIs

Each directory in `api/` is an API, and `api/` holds nothing else. `api/<name>/` declares the API
`<name>`, which the agent's programs import as `@api/<name>`: as with a package's types, they get
its `index.d.ts`, and the directory holds the files that one imports. The directory's name is the
API's only name, and matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`. This is `api/notes/index.d.ts`:

```ts
/**
 * A notebook of short notes, each with tags to find it by later.
 *
 * @packageDocumentation
 */

import type { Tag } from "./tags.js";

/** A saved note. */
export interface Note {
	readonly id: number;
	text: string;
	tags: Tag[];
	written: Date;
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: Tag[]): Promise<Note>;

/** Notes carrying `tag`, oldest first, as they are found. */
export declare function byTag(tag: Tag, signal?: AbortSignal): AsyncIterable<Note>;
```

An API's files are TypeScript declaration files, and may declare whatever one can: functions, sync
or async, overloaded or generic; classes, constants, namespaces, interfaces and types. Beyond what
TypeScript asks of such files, a tau asks this of its APIs:
- **They type-check.** The APIs' files are checked together by TypeScript 6.0, with `strict` on,
  imports resolved as Node.js resolves them (`"module": "NodeNext"`), and the ES2022 library and
  the types of Node.js 24 (`@types/node`) as the environment, since the agent's programs run on
  Node.js 24 or later. TypeScript must find no errors in them, and each `index.d.ts` is a module,
  so that programs can import it.
- **Each is self-contained.** An API's files lie in its directory, and import one another by
  relative paths, such as `./tags.js`. Beyond them, an API imports only another API of the tau, as
  `@api/<name>`, and Node.js's own modules, whose types are the environment's: no other package.
- **Documentation:** TSDoc. The first doc comment of `index.d.ts`, if it has
  `@packageDocumentation`, describes the API. Programs, and the agent, learn an API from its
  declarations and their doc comments.

The runtime gives `@api/<name>` (see [Implementations](implementations.md)). Wherever the tau's own
code, an API's files included, imports it, its declarations are `api/<name>/index.d.ts`, as a
`tsconfig.json` in the tau with `"paths": { "@api/*": ["./api/*/index.d.ts"] }` has it.
