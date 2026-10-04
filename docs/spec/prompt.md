# Prompt

`PROMPT.md` is the prompt. A runtime expands it once, for the run:
- `${name}` becomes the parameter `name`, when it is a text or a handle: a text as it is, a handle
  as its place, the absolute path where the agent sees it (see [Running](running.md)); or, when it
  is a list of texts or of handles, a JSON array of each as it would become, such as
  `["shopping","errands"]`;
- `${name.field}` becomes a field of a closed record the same way, through as many closed records
  as it lies in, as `${opts.style.font}` does;
- `${self}` becomes where the agent sees the tau's own directory, so that the prompt can name what
  the tau holds beside its prompt, such as a file to read or another tau to run;
- `$${` becomes a literal `${`.

Any other `${` is refused when the tau is read: one that is not closed on its line, names no
parameter or field, or names a record, a list of lists or of records, or what lies in a list or an
open record, whose length or names the tau cannot know. The agent's programs read those (see [Values](values.md)).
Nothing else is expanded, so `$1` or `$@` are text, and neither is what a value holds.
