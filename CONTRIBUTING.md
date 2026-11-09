# Contributing

Bug reports and pull requests are welcome. For anything bigger than a fix, open an issue first so
we can agree on the shape before you write it. Security problems go to security@noteblock.ai,
not an issue ([SECURITY.md](SECURITY.md)).

## Running it

```bash
pnpm install
pnpm dev       # Noteblock Dev: its own config and vault, never touches an installed Noteblock
pnpm check     # syntax checks, smoke tests and the build
```

`docs/contract.md` is the spec every part is built against. If your change alters behaviour it
describes, change the contract in the same pull request.

## Licenses and sign-off

The repo has two licenses:

- The page format, page runtime, CLI, MCP server, examples and skills (`core/`, `app/runtime/`,
  `cli/`, `mcp/`, `examples/`, `skills/`) are Apache-2.0. Sign off each commit
  (`git commit -s`), which certifies the [Developer Certificate of Origin](https://developercertificate.org).
- Everything else, mainly the desktop app, is FSL-1.1-ALv2 ([LICENSE.md](LICENSE.md)): use it for
  anything except a competing commercial product, and each release becomes Apache-2.0 two years
  after it ships.

For changes to FSL-licensed files we also need the agreement below, so that those contributions
can move to Apache-2.0 on schedule (or sooner) along with the rest of the code. Say "I agree to
the contributor agreement in CONTRIBUTING.md" in your first pull request.

### Contributor agreement

You keep the copyright in your contribution. You grant Harbor Apps LLC and anyone who receives the
software from it a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use,
copy, modify, sublicense and distribute your contribution under any license, and a patent license
on the same terms as section 3 of the Apache License 2.0. You confirm the contribution is your own
work, or that you have the right to submit it under these terms.
