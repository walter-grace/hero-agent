# Skill: fast file search (fff)

When the `--fff` flag (or an `--mcp "fff:..."` server) is attached, you have fff's file-search tools. fff (github.com/dmtrKovalenko/fff, MIT) keeps a resident in-memory index of the repo and answers in single-digit milliseconds, even on huge trees. Prefer it over spawning `grep`, `find`, `ripgrep`, or `ls` through the `shell` tool whenever you are searching a real codebase: it is faster, frecency-ranked, and does not fork a process per query.

Tools it exposes (hero-agent namespaces them as `fff__<tool>`):

- **fff__find_files**: fuzzy search by FILE NAME (not contents). Params: `query`, `maxResults`, `cursor`. Supports fuzzy matching, path prefixes (`src/`), and glob constraints (`name **/src/*.{ts,tsx} !test/`), and ranks by frecency (recently and frequently touched files first). Use it to locate a file when you know roughly what it is called or where it lives, e.g. `mcp`, `provider`, `bench run`.
- **fff__grep**: search file CONTENTS. Params: `query`, `output_mode`, `maxResults`, `cursor`. Search for bare identifiers (e.g. `createHeroAgent`, `mcpTools`), NOT regex or code syntax. Prefilter files with a constraint prefix: a glob (`*.rs query`), a directory ending in `/` (`src/ query`), or a filename. Use it to find where a symbol or string is defined or used.
- **fff__multi_grep**: search contents for lines matching ANY of several patterns (OR logic). Params: `patterns`, `constraints`, `context`, `output_mode`, `maxResults`, `cursor`. Patterns are literal text; never escape special characters. Use it when you want several related terms in one call instead of many `grep` calls.

How to work:

1. To find WHERE something is, start with `fff__find_files` (by name/path) or `fff__grep` (by content). Do not shell out to `grep -r` or `find` in a large repo when these are available.
2. Narrow with a constraint prefix (a glob, or a `src/`-style directory) rather than post-filtering, and skip noise like `node_modules` and lockfiles.
3. Search bare identifiers, not regex. For several terms at once, use `fff__multi_grep` with literal `patterns`.
4. Page with the returned `cursor` instead of re-running a broader query, and cap noise with `maxResults`.
5. Only fall back to the `shell` tool for search when fff's tools are not attached or the query truly needs shell semantics (pipelines, globbing beyond what the constraints support).

fff is optional. If these tools are not in your tool list, it is not enabled; use `shell` (grep/find) and say so if search is slow on a big tree.
