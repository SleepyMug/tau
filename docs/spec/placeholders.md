# Placeholders

A **placeholder** is `${`, a name, or names separated by `.`, and `}`, on one line. Placeholders
are in three places, and a runtime **expands** each, replacing it, once for the run, after placing
the files (see [Running](running.md)):
- `${self}` becomes where the agent sees the tau's own directory, so that the tau can name what it
  holds, such as a file to read or another tau to run;
- `${name}`, naming a file, becomes its place, the absolute path where the agent sees it.

In the prompt, `PROMPT.md`:
- `${self}` and `${name}` naming a file become as above;
- `${name}` naming an arg becomes its value, and `${name.field}` a value in it, through as many
  objects as it lies in, as `${dates.start}` does: a string as it is, and anything else as JSON,
  such as `["Lisbon","Porto"]`. What the args lack, such as an arg the call leaves out, or a field
  of what is not an object, becomes nothing. Each arg's placeholders are expanded first (see
  below), so a file an arg names reaches the prompt as its place;
- `$${` becomes a literal `${`.

Any other `${` in the prompt is refused when the tau is read: one that is not closed on its line,
whose first name is neither `self`, nor a file's that `tau.json` declares, nor an arg's that the
schema declares in its top-level `properties` (see [Metadata](metadata.md)), or that names what
lies in `self` or in a file. The prompt names no extra file, which the tau cannot know of: an arg
does.

In the args, in every string, at any depth, but not in the names of an object's properties:
- `${self}` and `${name}` naming a file, extra files included (see [Calls](calls.md)), become as
  above, so a caller can point the agent into a file, as `"Start from ${site}/index.html"` does;
- `${name}` preceded by one or more `$` loses one, whatever the name: `$${site}` becomes a
  literal `${site}`, and `$$${site}` becomes `$${site}`. A placeholder meant for a run the agent
  makes, which it passes on in that run's args, takes one `$` more for each run it passes
  through, so that each expands it once, and the one it is meant for expands it to a place.
  Text that holds `$${` as it is, such as a Makefile's, is written with one `$` more;
- anything else stays as written, so the args can hold code, or templates of their own, as they
  are.

In init (see [Init](init.md)):
- `${self}` and `${name}` naming a file that `tau.json` declares become as above, each as one word for `sh`, quoted if need
  be;
- `$${` becomes a literal `${`.

Any other `${` in init is refused when the tau is read: init names no arg, since an arg in a
command would break its quoting, and could run commands of the caller's choosing. It reads the args
through the tau API.

Nothing else is expanded, so `$1`, `$@` and `$name` are text, and so is what a file holds.

With the files `notes`, placed at `/in/notes.md`, and `site`, at `/work/site`, and the args
`{"style": "as in ${site}/about.html"}`, the prompt

```
Add what ${notes} says to the pages of ${site}, in a style ${style}.
```

becomes

```
Add what /in/notes.md says to the pages of /work/site, in a style as in /work/site/about.html.
```
