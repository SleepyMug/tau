# Results

A run succeeds when the agent **returns normally**, running to its end without being stopped or
failing, or, without the agent, when the tau's init skips it (see [Init](init.md)), and leaves at
the place of each `out` and `inout` file what [Paths](paths.md) asks. By the time the caller learns
that the run succeeded, the path of each holds what the agent left there: as the agent left it, at
a place that is the caller's own, or else put there from a copy: a directory merges into a
directory already there, each of its entries put the same way, and anything else replaces what is
there. What a run that fails leaves at those paths is not specified (see [Calls](calls.md)): a
caller that needs all or nothing gives fresh paths for its `out` files, and moves them once the run
succeeds.

Either way, the caller gets whether the run succeeded, why if it failed, and the agent's final
text. Nothing else comes out of a run: a runtime builds no structure from what the agent does.
Its trace, what its agent did, is no result: it is for a person looking into the run, in a form the
backend chooses, which nothing relies on (see [Protocol](protocol.md#traces)).

Anything else the agent writes, in its working directory or elsewhere, is scratch: nothing after
the run may rely on it, and a runtime may keep it or throw it away. Whether the agent did what it
was asked is not the runtime's to judge: a tau that needs to say so defines how, in its prompt, its
`out` files, and its final text.

Run as a command, without a person at the terminal, a runtime writes the agent's final text to
stdout, and why a run failed to stderr, and exits with 0 only when the run succeeded.
