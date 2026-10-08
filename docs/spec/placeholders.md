# Placeholders

A **placeholder** is `${`, a name, or names separated by `.`, and `}`, on one line. Placeholders
are in three places, the prompt, `PROMPT.md`, every string of the args, at any depth, but not the
names of an object's properties, and init, and a runtime **expands** each, replacing it, once for
the run, after placing the files (see [Running](running.md)). Everywhere, the same rules hold.

## What a placeholder names

- `${self}` becomes where the agent sees the tau's own directory, so that the tau can name what it
  holds, such as a file to read or another tau to run;
- `${name}`, naming a file, extra files included (see [Calls](calls.md)), becomes its place, the
  absolute path where the agent sees it;
- `${name}`, naming an arg, becomes its value, and `${name.field}` a value in it, through as many
  objects as it lies in, as `${dates.start}` does: a string as it is, and anything else as JSON,
  such as `["Lisbon","Porto"]`. What the args lack, such as an arg the call leaves out, or a field
  of what is not an object, becomes nothing.

A place is as it is. An arg's value is expanded first, each string in it, so a string arg may name
a file, as `"as in ${site}/about.html"` does, or another arg, or what lies in one, as
`"${page.name}.html"` does, and reaches the prompt, and the agent's programs, expanded. A value
cannot name itself, through as many others as it does: `{"a": "${b}", "b": "${a}"}` is refused,
and so is `{"o": {"x": "${o}"}}`, while `{"o": {"x": "${o.y}", "y": "hi"}}` is not.

## Escaping

A run of `$` before a `{` loses one when it is more than one, whatever follows: `$${trip}` becomes
a literal `${trip}`, and `$$${trip}` becomes `$${trip}`. Any other `$`, as in `$1`, `$@` or
`$name`, is text. To write any text as it is, add one `$` to each run of `$` before a `{`.

What expanding gives is text, and is not expanded again. So a placeholder meant for a run the
agent makes, which it passes on in that run's args, takes one `$` more for each run it passes
through, so that each expands it once, and the one it is meant for expands it to a place (see
[Calls](calls.md)). Text that holds `${` as it is, such as a template or code, in the args as in
the prompt, is written with one `$` more.

## What each may name

Any other `${` is refused:
- in the prompt, when the tau is read: one that is not closed on its line, whose first name is
  neither `self`, nor a file's that `tau.json` declares, nor an arg's that the schema declares in
  its top-level `properties` (see [Metadata](metadata.md)), or that names what lies in `self` or
  in a file. The prompt names no extra file, which the tau cannot know of: an arg does.
- in the args, with the call: the same, but naming any file the call gives, and any arg the call
  gives or the schema declares.
- in init, when the tau is read: any that names more than `self` or a file `tau.json` declares.
  Init names no arg, since an arg in a command would break its quoting, and could run commands of
  the caller's choosing. It reads the args through the tau API (see [Init](init.md)). Each
  placeholder in init becomes one word for `sh`, quoted if need be.

Nothing else is expanded: what a file holds is as it is.

With the files `notes`, placed at `/in/notes.md`, and `site`, at `/work/site`, and the args
`{"style": "as in ${site}/about.html"}`, the prompt

```
Add what ${notes} says to the pages of ${site}, in a style ${style}.
```

becomes

```
Add what /in/notes.md says to the pages of /work/site, in a style as in /work/site/about.html.
```
