# Prompt

`PROMPT.md` is the prompt: what the agent is asked. A runtime expands it once, for the run (see
[Placeholders](placeholders.md)), and runs the agent on what that gives, unless the tau's init does
the run without it (see [Init](init.md)).

What the model learns of the call, the prompt tells it: the prompt names files, args and what lies
in them, and says what the agent needs of the rest, which the agent's programs read through the
[tau API](tau-api.md). A runtime need not show the model the call otherwise.
